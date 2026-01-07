import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { retrieveDoc, formatDocuments, graph } from "./rag-chain";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API endpoint to process queries (must be before static middleware)
app.post("/api/query", async (req, res) => {
  // Set a response timeout to prevent hanging (25 seconds - Render free tier limit is 30s)
  const TIMEOUT_MS = 25000; // 25 seconds
  
  // Create a timeout promise
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error("Request timeout: The operation took too long. Please try with fewer URLs or a simpler question."));
    }, TIMEOUT_MS);
  });

  let responseSent = false;
  
  const sendResponse = (status: number, data: any) => {
    if (!responseSent) {
      responseSent = true;
      res.status(status).json(data);
    }
  };

  try {
    const { urls, question } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      sendResponse(400, { error: "Please provide at least one URL" });
      return;
    }

    if (!question || question.trim() === "") {
      sendResponse(400, { error: "Please provide a question" });
      return;
    }

    // Limit URLs to prevent timeout
    if (urls.length > 3) {
      sendResponse(400, { 
        error: "Too many URLs. Please provide a maximum of 3 URLs at a time." 
      });
      return;
    }

    console.log(`[API] Processing query: "${question}" for ${urls.length} URL(s)`);
    console.log(`[API] Request received at: ${new Date().toISOString()}`);

    const startTime = Date.now();
    
    // Race between graph execution and timeout
    const result = await Promise.race([
      graph.invoke({ question, urls }),
      timeoutPromise,
    ]) as any;
    
    const duration = Date.now() - startTime;
    
    console.log(`[API] Graph execution completed in ${duration}ms`);
    console.log("[API] Graph result:", {
      documentCount: result.documents?.length ?? 0,
      hasGeneratedAnswer: !!result.generatedAnswer,
    });
    
    const formattedDocs = formatDocuments(result.documents ?? []);

    const response = {
      success: true,
      question,
      documents: formattedDocs,
      documentCount: formattedDocs.length,
      generatedAnswer: result.generatedAnswer,
    };

    console.log(`[API] Sending response with ${formattedDocs.length} documents`);
    sendResponse(200, response);
  } catch (error: any) {
    console.error("[API] Error processing query:", error);
    console.error("[API] Error stack:", error.stack);
    
    // Check if it's a timeout error
    const isTimeout = error.message && error.message.includes("timeout");
    
    sendResponse(isTimeout ? 408 : 500, {
      error: isTimeout 
        ? "Request Timeout" 
        : "Failed to process query",
      message: error.message || "Unknown error occurred",
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
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

