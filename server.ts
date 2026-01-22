import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { retrieveDoc, formatDocuments, graph, buildVectorStore } from "./rag-chain";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { ChatOllama } from "@langchain/ollama";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import * as os from "os";
import multer from "multer";
import pdfParse from "pdf-parse";
import { Document } from "@langchain/core/documents";

const app = express();
const PORT = process.env.PORT || 3000;

// Cache vector stores by URL set (as a string key)
const vectorStoreCache = new Map<string, MemoryVectorStore>();
const uploadStore = new Map<string, { name: string; type: string; content: string; createdAt: number }>();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// CPU usage monitoring endpoint
app.get("/api/cpu-usage", (req, res) => {
  const cpus = os.cpus();
  const totalIdle = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0);
  const totalTick = cpus.reduce((acc, cpu) => 
    acc + Object.values(cpu.times).reduce((sum: number, time: number) => sum + time, 0), 0
  );
  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  const usage = 100 - ~~(100 * idle / total);
  
  const memUsage = process.memoryUsage();
  
  res.json({
    cpu: {
      usage: usage,
      cores: cpus.length,
      model: cpus[0].model,
      speed: cpus[0].speed,
      loadAverage: os.loadavg(),
    },
    memory: {
      used: Math.round(memUsage.heapUsed / 1024 / 1024),
      total: Math.round(memUsage.heapTotal / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024),
      rss: Math.round(memUsage.rss / 1024 / 1024),
    },
    system: {
      freeMemory: Math.round(os.freemem() / 1024 / 1024),
      totalMemory: Math.round(os.totalmem() / 1024 / 1024),
      uptime: process.uptime(),
    },
    timestamp: new Date().toISOString(),
  });
});

type UploadedFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

// Upload documents (text or PDF)
app.post("/api/upload", upload.array("files", 10), async (req, res) => {
  try {
    const files = ((req as any).files as UploadedFile[]) ?? [];
    if (files.length === 0) {
      return res.status(400).json({ error: "Please upload at least one file" });
    }

    const results = [];
    for (const file of files) {
      let content = "";
      if (file.mimetype === "application/pdf") {
        const parsed = await pdfParse(file.buffer);
        content = parsed.text ?? "";
      } else if (
        file.mimetype.startsWith("text/") ||
        file.mimetype === "application/json"
      ) {
        content = file.buffer.toString("utf8");
      } else {
        return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      uploadStore.set(id, {
        name: file.originalname,
        type: file.mimetype,
        content,
        createdAt: Date.now(),
      });

      results.push({ id, name: file.originalname, type: file.mimetype, size: file.size });
    }

    res.json({ success: true, files: results });
  } catch (error: any) {
    console.error("[API] Error uploading files:", error);
    res.status(500).json({ error: "Failed to upload files", message: error.message });
  }
});

app.delete("/api/uploads/clear", (req, res) => {
  uploadStore.clear();
  res.json({ success: true });
});

interface RagConfig {
  chunkSize?: number;
  chunkOverlap?: number;
  retrieverStrategy?: "mmr" | "similarity";
  retrieverK?: number;
  retrieverFetchK?: number;
  retrieverLambda?: number;
}

function normalizeRagConfig(input: any): RagConfig | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const toNumber = (value: any) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const normalized: RagConfig = {
    chunkSize: toNumber(input.chunkSize),
    chunkOverlap: toNumber(input.chunkOverlap),
    retrieverStrategy: typeof input.retrieverStrategy === "string"
      ? (input.retrieverStrategy as RagConfig["retrieverStrategy"])
      : undefined,
    retrieverK: toNumber(input.retrieverK),
    retrieverFetchK: toNumber(input.retrieverFetchK),
    retrieverLambda: toNumber(input.retrieverLambda),
  };

  if (Object.values(normalized).every(value => value === undefined)) {
    return undefined;
  }

  return normalized;
}

function buildVectorStoreCacheKey(urls: string[], ragConfig?: RagConfig) {
  const chunkKey = ragConfig?.chunkSize ?? "auto";
  const overlapKey = ragConfig?.chunkOverlap ?? "auto";
  return `${urls.sort().join("|")}::chunk=${chunkKey}::overlap=${overlapKey}`;
}

function buildVectorStoreCacheKeyWithUploads(urls: string[], uploadIds: string[], ragConfig?: RagConfig) {
  const baseKey = buildVectorStoreCacheKey(urls, ragConfig);
  const uploadsKey = uploadIds.length > 0 ? uploadIds.sort().join("|") : "none";
  return `${baseKey}::uploads=${uploadsKey}`;
}

function getUploadedDocuments(uploadIds: string[]): Document[] {
  const docs: Document[] = [];
  for (const id of uploadIds) {
    const entry = uploadStore.get(id);
    if (!entry) continue;
    docs.push(new Document({
      pageContent: entry.content,
      metadata: { source: "upload", name: entry.name, type: entry.type, id },
    }));
  }
  return docs;
}

// Endpoint to generate sample questions from documents
app.post("/api/sample-questions", async (req, res) => {
  try {
    const { urls = [], uploadIds = [], ragConfig } = req.body;
    const normalizedRagConfig = normalizeRagConfig(ragConfig);

    if ((!Array.isArray(urls) || urls.length === 0) && (!Array.isArray(uploadIds) || uploadIds.length === 0)) {
      return res.status(400).json({ error: "Please provide at least one URL or uploaded document" });
    }

    if (urls.length > 3) {
      return res.status(400).json({ 
        error: "Too many URLs. Please provide a maximum of 3 URLs at a time." 
      });
    }

    // Get or create vector store
    const vectorStore = await getOrCreateVectorStore(urls, uploadIds, normalizedRagConfig);
    
    // Retrieve representative chunks using embeddings (topic-oriented query)
    const sampleDocs = await vectorStore.similaritySearch(
      "main topics, key entities, important facts, and summary",
      10
    );

    if (sampleDocs.length === 0) {
      return res.json({ 
        success: true, 
        questions: [
          "What is the main topic of this document?",
          "Can you summarize the key points?",
          "What are the important details mentioned?",
        ]
      });
    }

    // Use LLM to generate sample questions based on document content
    const model = new ChatOllama({
      model: "qwen2.5:3b",
      temperature: 0.3,
    });

    const context = sampleDocs
      .slice(0, 8)
      .map((doc, index) => {
        const source = doc.metadata?.name || doc.metadata?.source || `chunk-${index + 1}`;
        return `Source: ${source}\n${doc.pageContent}`;
      })
      .join("\n\n");
    
    const prompt = ChatPromptTemplate.fromTemplate(
      `You are generating suggested questions for a RAG system. 
Return 6 specific, diverse questions that are directly grounded in the provided excerpts.
Avoid generic questions like "What is the main topic?" unless the excerpts are too short.
Prefer questions that mention concrete entities, places, numbers, or events from the excerpts.
Return a JSON array of strings only.

Document excerpts:
{context}

Questions JSON:`
    );

    const chain = prompt.pipe(model).pipe(new StringOutputParser());
    const questionsText = await chain.invoke({ context });
    
    // Parse questions (JSON array preferred, fallback to line split)
    let questions: string[] = [];
    try {
      const cleaned = questionsText
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        questions = parsed.map(q => String(q).trim()).filter(q => q.length > 0);
      }
    } catch {
      const cleaned = questionsText
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      questions = cleaned
        .split('\n')
        .map(q => q.trim())
        .filter(q => q.length > 0 && !q.match(/^\d+[\.\)]/));
    }

    questions = questions
      .map(q => q.replace(/^["'\[\]\s]+|["'\[\]\s]+$/g, "").trim())
      .filter(q => q.length >= 8 && !q.match(/^(json|\[|\])$/i))
      .slice(0, 3);

    res.json({ 
      success: true, 
      questions: questions.length > 0 ? questions : [
        "What is the main topic of this document?",
        "Can you summarize the key points?",
        "What are the important details mentioned?",
      ]
    });
  } catch (error: any) {
    console.error("[API] Error generating sample questions:", error);
    // Return default questions on error
    res.json({ 
      success: true, 
      questions: [
        "What is the main topic of this document?",
        "Can you summarize the key points?",
        "What are the important details mentioned?",
      ]
    });
  }
});

// Helper function to get or create vector store
async function getOrCreateVectorStore(
  urls: string[],
  uploadIds: string[],
  ragConfig?: RagConfig
): Promise<MemoryVectorStore> {
  const cacheKey = buildVectorStoreCacheKeyWithUploads(urls, uploadIds, ragConfig);
  
  if (vectorStoreCache.has(cacheKey)) {
    console.log(`[Cache] Using cached vector store for ${urls.length} URL(s)`);
    return vectorStoreCache.get(cacheKey)!;
  }
  
  console.log(`[Cache] Building new vector store for ${urls.length} URL(s)`);
  console.log(`[CPU] ⚠️  This operation is CPU-intensive (embedding generation)`);
  const startTime = Date.now();
  const memBefore = process.memoryUsage();
  
  const uploadedDocs = getUploadedDocuments(uploadIds);
  const vectorStore = await buildVectorStore(urls, ragConfig, uploadedDocs);
  
  const duration = Date.now() - startTime;
  const memAfter = process.memoryUsage();
  const memUsed = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
  
  console.log(`[CPU] ✅ Vector store built in ${duration}ms, used ${memUsed.toFixed(2)} MB memory`);
  vectorStoreCache.set(cacheKey, vectorStore);
  return vectorStore;
}

// API endpoint to process chat messages
app.post("/api/chat", async (req, res) => {
  // Configurable timeout: longer for local dev, shorter for production (Render free tier)
  // First-time vector store building can take 30-90 seconds, cached queries are much faster
  const DEFAULT_TIMEOUT_MS = process.env.NODE_ENV === "production" ? 25000 : 120000; // 2 minutes for dev, 25s for prod
  const FIRST_LOAD_TIMEOUT_MS = 180000; // 3 minutes for first-time vector store building
  
  let responseSent = false;
  let timeoutId: NodeJS.Timeout | null = null;
  
  const sendResponse = (status: number, data: any) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (!responseSent) {
      responseSent = true;
      res.status(status).json(data);
    }
  };

  const createTimeoutPromise = (timeoutMs: number) => {
    return new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timeoutId = null;
        reject(new Error("Request timeout: The operation took too long. This usually happens on the first request when building the vector store. Please wait a bit longer or try again."));
      }, timeoutMs);
    });
  };

  try {
    const { urls = [], uploadIds = [], message, conversationHistory = [], ragConfig } = req.body;
    const normalizedRagConfig = normalizeRagConfig(ragConfig);

    if ((!Array.isArray(urls) || urls.length === 0) && (!Array.isArray(uploadIds) || uploadIds.length === 0)) {
      sendResponse(400, { error: "Please provide at least one URL or uploaded document" });
      return;
    }

    if (!message || message.trim() === "") {
      sendResponse(400, { error: "Please provide a message" });
      return;
    }

    // Limit URLs to prevent timeout
    if (urls.length > 3) {
      sendResponse(400, { 
        error: "Too many URLs. Please provide a maximum of 3 URLs at a time." 
      });
      return;
    }

    const normalizedMessage = message.trim().toLowerCase();
    
    // Handle greetings and simple conversational messages
    const greetings = ['hi', 'hello', 'hey', 'greetings', 'good morning', 'good afternoon', 'good evening'];
    const isGreeting = greetings.some(greeting => 
      normalizedMessage === greeting || 
      normalizedMessage.startsWith(greeting + ' ') ||
      normalizedMessage === greeting + '!'
    );

    if (isGreeting) {
      const greetingResponses = [
        "Hello! I'm here to help you with questions about the documents. What would you like to know?",
        "Hi! How can I assist you today? Feel free to ask me anything about the documents.",
        "Hello! I can help answer questions based on the documents you've provided. What would you like to know?",
        "Hi there! I'm ready to help. What questions do you have about the documents?",
      ];
      const randomResponse = greetingResponses[Math.floor(Math.random() * greetingResponses.length)];
      
      sendResponse(200, {
        success: true,
        message: randomResponse,
        documents: [],
      });
      return;
    }

    // Handle other simple conversational messages
    const simpleResponses: { [key: string]: string } = {
      'how are you': "I'm doing well, thank you! I'm here to help you with questions about the documents. What would you like to know?",
      'how are you doing': "I'm doing great! Ready to help you with any questions about the documents. What can I assist you with?",
      'thanks': "You're welcome! Is there anything else you'd like to know?",
      'thank you': "You're welcome! Feel free to ask if you have more questions.",
      'bye': "Goodbye! Feel free to come back if you have more questions.",
      'goodbye': "Goodbye! Have a great day!",
    };

    if (simpleResponses[normalizedMessage]) {
      sendResponse(200, {
        success: true,
        message: simpleResponses[normalizedMessage],
        documents: [],
      });
      return;
    }

    console.log(`[API] Processing chat message: "${message}" for ${urls.length} URL(s)`);
    console.log(`[API] Conversation history length: ${conversationHistory.length}`);
    console.log(`[API] Request received at: ${new Date().toISOString()}`);
    
    // Log initial CPU/memory stats
    const memBefore = process.memoryUsage();
    const cpuBefore = os.loadavg();

    const startTime = Date.now();
    
    // Check if vector store needs to be built (first time)
    const cacheKey = buildVectorStoreCacheKeyWithUploads(urls, uploadIds, normalizedRagConfig);
    const isFirstLoad = !vectorStoreCache.has(cacheKey);
    const timeoutMs = isFirstLoad ? FIRST_LOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    
    if (isFirstLoad) {
      console.log(`[API] First-time load detected - using extended timeout of ${timeoutMs / 1000}s`);
      console.log(`[API] This may take 30-90 seconds to build the vector store...`);
    }
    
    // Get or create vector store (cached) - this can take time on first load
    // Wrap in timeout to catch if vector store building takes too long
    const vectorStoreTimeoutPromise = createTimeoutPromise(timeoutMs);
    const vectorStore = await Promise.race([
      getOrCreateVectorStore(urls, uploadIds, normalizedRagConfig),
      vectorStoreTimeoutPromise,
    ]) as MemoryVectorStore;
    
    // Clear the first timeout
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    
    // Execute graph with timeout
    const graphTimeoutMs = isFirstLoad ? 60000 : DEFAULT_TIMEOUT_MS; // 1 min for graph after vector store is ready
    const graphTimeoutPromise = createTimeoutPromise(graphTimeoutMs);
    
    const graphPromise = graph.invoke({ 
      question: message, 
      urls,
      vectorStore,
      conversationHistory: conversationHistory.map((msg: any) => ({
        role: msg.role,
        content: msg.content
      })),
      ragConfig: normalizedRagConfig,
      uploadIds,
    });
    
    // Race between graph execution and timeout
    const result = await Promise.race([
      graphPromise,
      graphTimeoutPromise,
    ]) as any;
    
    const duration = Date.now() - startTime;
    const memAfter = process.memoryUsage();
    const cpuAfter = os.loadavg();
    const memDelta = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
    
    console.log(`[API] Graph execution completed in ${duration}ms`);
    console.log(`[CPU] Memory delta: ${memDelta > 0 ? '+' : ''}${memDelta.toFixed(2)} MB`);
    console.log(`[CPU] System load: ${cpuAfter[0].toFixed(2)} (1min avg)`);
    console.log("[API] Graph result:", {
      documentCount: result.documents?.length ?? 0,
      hasGeneratedAnswer: !!result.generatedAnswer,
    });

    const response = {
      success: true,
      message: result.generatedAnswer || "I couldn't find a relevant answer to your question. Can I assist you with anything else?",
      documents: result.documents ? formatDocuments(result.documents) : [],
    };

    console.log(`[API] Sending chat response`);
    sendResponse(200, response);
  } catch (error: any) {
    // Clear timeout if still active
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    
    console.error("[API] Error processing chat:", error);
    if (error.stack) {
      console.error("[API] Error stack:", error.stack);
    }
    
    // Check if it's a timeout error
    const isTimeout = error.message && error.message.includes("timeout");
    
    // Don't send response if already sent
    if (!responseSent) {
      sendResponse(isTimeout ? 408 : 500, {
        error: isTimeout 
          ? "Request Timeout" 
          : "Failed to process message",
        message: error.message || "Unknown error occurred",
        details: process.env.NODE_ENV === "development" ? error.stack : undefined,
      });
    }
  }
});

// Keep old endpoint for backward compatibility
app.post("/api/query", async (req, res) => {
  try {
    const { urls = [], uploadIds = [], question, ragConfig } = req.body;
    const normalizedRagConfig = normalizeRagConfig(ragConfig);
    if ((!Array.isArray(urls) || urls.length === 0) && (!Array.isArray(uploadIds) || uploadIds.length === 0)) {
      return res.status(400).json({ error: "Please provide at least one URL or uploaded document" });
    }
    if (!question || question.trim() === "") {
      return res.status(400).json({ error: "Please provide a question" });
    }
    const vectorStore = await getOrCreateVectorStore(urls, uploadIds, normalizedRagConfig);
    const result = await graph.invoke({ question, urls, vectorStore, conversationHistory: [], ragConfig: normalizedRagConfig, uploadIds });
    const formattedDocs = formatDocuments(result.documents ?? []);
    res.json({
      success: true,
      question,
      documents: formattedDocs,
      documentCount: formattedDocs.length,
      generatedAnswer: result.generatedAnswer,
    });
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to process query",
      message: error.message,
    });
  }
});

// Serve static files (after API routes)
app.use(express.static(path.join(__dirname, "public")));

// Serve the HTML file for all other routes (SPA fallback)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 RAG Agent server running at http://localhost:${PORT}`);
  console.log(`📝 Open your browser and navigate to http://localhost:${PORT}`);
});

