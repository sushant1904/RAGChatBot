import { Document, DocumentInterface } from "@langchain/core/documents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOllama } from "@langchain/ollama";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/hf_transformers";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";

export interface GraphInterface {
  question: string;
  urls?: string[];
  uploadIds?: string[];
  generatedAnswer?: string;
  documents?: DocumentInterface[];
  model?: ChatOllama;
  conversationHistory?: Array<{ role: string; content: string }>;
  vectorStore?: MemoryVectorStore;
  ragConfig?: RagConfig;
}

interface RagConfig {
  chunkSize?: number;
  chunkOverlap?: number;
  retrieverStrategy?: "mmr" | "similarity";
  retrieverK?: number;
  retrieverFetchK?: number;
  retrieverLambda?: number;
}

const createModel = async () => {
  return new ChatOllama({
    model: "qwen2.5:3b",
    temperature: 0,
  });
};


const gradeGeneratedAnswer = async (state: GraphInterface) => {
  const model = state.model ?? (await createModel());
  
  // Only grade if we have a generated answer
  if (!state.generatedAnswer || state.generatedAnswer.trim() === "") {
    return {gradeGeneratedAnswer: "I couldn't find a relevant answer to your question. Can I assist you with anything else?"};
  }
  
  const gradePrompter = ChatPromptTemplate.fromTemplate(
    `You are a grader deciding if a generated answer is relevant and helpful for a question.
Consider an answer relevant if it:
- Directly answers the question
- Provides related information that could be useful
- Mentions the topic even if incomplete

Question: {question}

Generated Answer: {generatedAnswer}

Answer with a single word: 'yes' or 'no'.`
  );
  
  const graderChain = gradePrompter.pipe(model).pipe(new StringOutputParser());
  
  try {
    const result = await graderChain.invoke({
      question: state.question,
      generatedAnswer: state.generatedAnswer ?? "",
    });
    
    // Only reject if explicitly "no" - be more lenient
    if (String(result).toLowerCase().trim() === "no") {
      console.log(`[gradeGeneratedAnswer] Answer rejected, but returning it anyway with a note`);
      // Return the answer anyway, but with a note
      return {
        ...state,
        generatedAnswer: state.generatedAnswer + " (Note: This information may be incomplete based on available documents.)"
      };
    }
  } catch (error) {
    console.warn(`[gradeGeneratedAnswer] Error grading answer, returning it anyway:`, error);
    // If grading fails, return the answer anyway
  }
  
  return state;
};

const generateAnswer = async (state: GraphInterface) => {
  const model = state.model ?? (await createModel());
  const documents = (state.documents ?? []) as Document[];
  const conversationHistory = state.conversationHistory ?? [];
  
  // Format conversation history for context
  const historyContext = conversationHistory.length > 0
    ? conversationHistory
        .slice(-6) // Keep last 6 messages for context
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join("\n")
    : "";
  
  // Create RAG prompt template with conversation history
  const ragPrompt = ChatPromptTemplate.fromTemplate(
    `You are an assistant for question-answering tasks. Use the following pieces of retrieved context to answer the question accurately and comprehensively.

Instructions:
- Extract relevant information from the context to answer the question
- If the context contains the answer, provide it clearly
- If the context doesn't contain enough information, say what you can determine from the available context
- Be specific and cite information from the context when possible
- Keep the answer informative but concise (2-4 sentences)

${historyContext ? `Previous conversation:\n${historyContext}\n\n` : ""}Context from documents:\n{context}

Question: {question}

Answer:`
  );
  
  // Format documents as context string
  const context = documents.map(doc => doc.pageContent).join("\n\n");
  
  console.log(`[generateAnswer] Using ${documents.length} document(s) with total context length: ${context.length} chars`);
  if (documents.length === 0) {
    console.warn(`[generateAnswer] WARNING: No documents provided for answer generation`);
  }
  
  const ragChain = ragPrompt.pipe(model).pipe(new StringOutputParser());
  const generatedAnswer = await ragChain.invoke({
    question: state.question,
    context: context
  });
  
  console.log(`[generateAnswer] Generated answer length: ${generatedAnswer.length} chars`);
  return {generatedAnswer};
};

const hasRelevantDocs = (state: GraphInterface) => {
  const relevantDocs = (state.documents ?? []) as Document[];
  if (relevantDocs.length == 0) 
    {
      return "no";
    }
    return "yes";
};



const documentGrader = async (state: GraphInterface) => {
  const docs = (state.documents ?? []) as Document[];
  const model = state.model ?? (await createModel());

  console.log(`[documentGrader] Grading ${docs.length} document(s) for relevance`);

  // Improved prompt to be less strict - consider partial relevance
  const gradePrompter = ChatPromptTemplate.fromTemplate(
    `You are a grader deciding if a document is relevant to a question. 
A document is relevant if it contains information that could help answer the question, even partially.
Consider documents relevant if they mention the topic, location, or related concepts.

Question: {question}

Document: {document}

Answer with a single word: 'yes' or 'no'. Do not return any other text.`
  );

  const docGrader = gradePrompter.pipe(model).pipe(new StringOutputParser());
  const relevantDocs: Document[] = [];

  for (const doc of docs) {
    try {
      const result = await docGrader.invoke({
        question: state.question,
        document: doc.pageContent.substring(0, 1000), // Limit document size for grading to avoid token limits
      });

      if (String(result).toLowerCase().includes("yes")) {
        relevantDocs.push(doc);
      }
    } catch (error) {
      // If grading fails, include the document anyway to avoid losing potentially relevant info
      console.warn(`[documentGrader] Error grading document, including it anyway:`, error);
      relevantDocs.push(doc);
    }
  }

  // If no documents passed grading, keep at least the top 3 most similar ones
  if (relevantDocs.length === 0 && docs.length > 0) {
    console.log(`[documentGrader] No documents passed strict grading, keeping top ${Math.min(3, docs.length)} documents`);
    relevantDocs.push(...docs.slice(0, Math.min(3, docs.length)));
  }

  console.log(`[documentGrader] Found ${relevantDocs.length} relevant document(s) out of ${docs.length}`);
  return { ...state, documents: relevantDocs, model };
};

export async function buildVectorStore(urls: string[], ragConfig?: RagConfig, additionalDocs: Document[] = []) {
  const docs = await Promise.all(
    urls.map(async (url) => {
      const loader = new CheerioWebBaseLoader(url);
      return loader.load();
    })
  );

  const flatDocs = docs.flat().concat(additionalDocs);
  const totalChars = flatDocs.reduce((sum, doc) => sum + doc.pageContent.length, 0);
  const avgDocLength = flatDocs.length ? totalChars / flatDocs.length : 0;

  const explicitChunkSize = ragConfig?.chunkSize ?? Number(process.env.CHUNK_SIZE);
  const explicitOverlap = ragConfig?.chunkOverlap ?? Number(process.env.CHUNK_OVERLAP);
  const useExplicit = Number.isFinite(explicitChunkSize) && (explicitChunkSize as number) > 0;

  // Auto-tune chunking based on document size, with env overrides.
  let chunkSize = useExplicit ? (explicitChunkSize as number) : 700;
  if (!useExplicit) {
    if (avgDocLength > 6000) {
      chunkSize = 900;
    } else if (avgDocLength < 1500) {
      chunkSize = 400;
    }
  }
  const chunkOverlap = Number.isFinite(explicitOverlap) && (explicitOverlap as number) >= 0
    ? (explicitOverlap as number)
    : Math.round(chunkSize * 0.2);

  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ["\n\n", "\n", ". ", " ", ""],
    keepSeparator: true,
  });

  const splitDocs = await textSplitter.splitDocuments(flatDocs);

  const embeddings = new HuggingFaceTransformersEmbeddings({
    model: "Xenova/bge-small-en-v1.5",
  });

  const vectorStore = new MemoryVectorStore(embeddings);
  await vectorStore.addDocuments(splitDocs);
  
  return vectorStore;
}

export async function retrieveDoc(
  urls: string[],
  question: string,
  ragConfig?: RagConfig,
  additionalDocs: Document[] = []
): Promise<{ documents: Document[] }> {
  const vectorStoreInstance = await buildVectorStore(urls, ragConfig, additionalDocs);
  const retriever = getRetriever(vectorStoreInstance, ragConfig);
  const retrievedDocs = await retriever.invoke(question);

  return { documents: retrievedDocs };
}

function getRetriever(vectorStoreInstance: MemoryVectorStore, ragConfig?: RagConfig) {
  const k = ragConfig?.retrieverK ?? Number(process.env.RETRIEVER_K ?? 12);
  const fetchK = ragConfig?.retrieverFetchK ?? Number(process.env.RETRIEVER_FETCH_K ?? 40);
  const lambda = ragConfig?.retrieverLambda ?? Number(process.env.RETRIEVER_LAMBDA ?? 0.6);
  const searchType = (ragConfig?.retrieverStrategy ?? process.env.RETRIEVER_STRATEGY ?? "similarity").toLowerCase();

  const retrieverConfig = {
    k,
    ...(searchType === "mmr"
      ? { searchType: "mmr", searchKwargs: { fetchK, lambda } }
      : {}),
  } as any;

  return vectorStoreInstance.asRetriever(retrieverConfig);
}

// Node function for LangGraph that takes state
const retrieveDocNode = async (state: GraphInterface) => {
  const urls = state.urls ?? [];
  const vectorStore = state.vectorStore;
  
  console.log(`[retrieveDocNode] Retrieving documents for question: "${state.question}" from ${urls.length} URL(s)`);
  
  // Use provided vector store or build a new one
  let vectorStoreInstance: MemoryVectorStore;
  if (vectorStore) {
    vectorStoreInstance = vectorStore;
  } else {
    const result = await retrieveDoc(urls, state.question, state.ragConfig);
    console.log(`[retrieveDocNode] Retrieved ${result.documents.length} document(s) from vector store`);
    return { documents: result.documents };
  }
  
  // Retrieve more documents to increase chances of finding relevant information
  const retriever = getRetriever(vectorStoreInstance, state.ragConfig);
  const retrievedDocs = await retriever.invoke(state.question);
  
  console.log(`[retrieveDocNode] Retrieved ${retrievedDocs.length} document(s) from vector store`);
  return { documents: retrievedDocs };
};

// Node function for LangGraph that creates model
const createModelNode = async (state: GraphInterface) => {
  const model = await createModel();
  return { model };
};

export function formatDocuments(docs: Document[]): string[] {
  return docs.map((doc) => doc.pageContent);
}

// Define the state schema for LangGraph using Annotation
const GraphState = Annotation.Root({
  question: Annotation<string>,
  urls: Annotation<string[]>({
    reducer: (x: string[], y: string[]) => y ?? x,
    default: () => [] as string[],
  }),
  generatedAnswer: Annotation<string>({
    reducer: (x: string, y: string) => y || x,
    default: () => "",
  }),
  documents: Annotation<Document[]>({
    reducer: (x: Document[], y: Document[]) => y ?? x,
    default: () => [] as Document[],
  }),
  model: Annotation<ChatOllama>({
    reducer: (x: ChatOllama, y: ChatOllama) => y ?? x,
    default: () => undefined as any,
  }),
  conversationHistory: Annotation<Array<{ role: string; content: string }>>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  vectorStore: Annotation<MemoryVectorStore>({
    reducer: (x: MemoryVectorStore, y: MemoryVectorStore) => y ?? x,
    default: () => undefined as any,
  }),
  ragConfig: Annotation<RagConfig | undefined>({
    reducer: (x: RagConfig | undefined, y: RagConfig | undefined) => y ?? x,
    default: () => undefined,
  }),
  uploadIds: Annotation<string[] | undefined>({
    reducer: (x: string[] | undefined, y: string[] | undefined) => y ?? x,
    default: () => undefined,
  }),
});

export const graph = new StateGraph(GraphState)
  .addNode("retrieve_documents", retrieveDocNode)
  .addNode("create_model", createModelNode)
  .addNode("grade_documents", documentGrader)
  .addNode("generate_answer", generateAnswer)
  .addNode("grade_generated_answer", gradeGeneratedAnswer)
  .addEdge(START, "retrieve_documents")
  .addEdge("retrieve_documents", "create_model")
  .addEdge("create_model", "grade_documents")
  .addConditionalEdges("grade_documents", hasRelevantDocs, {
    "yes": "generate_answer",
    "no": END,
  })
  .addEdge("generate_answer", "grade_generated_answer")
  .addEdge("grade_generated_answer", END)
  .compile();
