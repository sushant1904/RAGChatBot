import { Document, DocumentInterface } from "@langchain/core/documents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/hf_transformers";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";

export interface GraphInterface {
  question: string;
  urls?: string[];
  generatedAnswer?: string;
  documents?: DocumentInterface[];
  model?: ChatOpenAI;
}

const createModel = async () => {
  return new ChatOpenAI({
    model: "gpt-4.1",
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY,
  });
};


const gradeGeneratedAnswer = async (state: GraphInterface) => {
  const model = state.model ?? (await createModel());
  
  const gradePrompter = ChatPromptTemplate.fromTemplate(
    "You are a grader deciding if a generated answer is relevant to a question.\n\nQuestion:\n{question}\n\nGenerated Answer:\n{generatedAnswer}\n\nAnswer with a single word: 'yes' or 'no'."
  );
  
  const graderChain = gradePrompter.pipe(model).pipe(new StringOutputParser());
  const result = await graderChain.invoke({
    question: state.question,
    generatedAnswer: state.generatedAnswer ?? "",
  });
  if (String(result).toLowerCase().includes("no")) {
    return {gradeGeneratedAnswer: "Sorry, I don't know the answer to that question."};
  }
  return state;
};

const generateAnswer = async (state: GraphInterface) => {
  const model = state.model ?? (await createModel());
  const documents = (state.documents ?? []) as Document[];
  
  // Create RAG prompt template
  const ragPrompt = ChatPromptTemplate.fromTemplate(
    "You are an assistant for question-answering tasks. Use the following pieces of retrieved context to answer the question. If you don't know the answer, just say that you don't know. Use three sentences maximum and keep the answer concise.\n\nContext:\n{context}\n\nQuestion: {question}\n\nAnswer:"
  );
  
  // Format documents as context string
  const context = documents.map(doc => doc.pageContent).join("\n\n");
  
  const ragChain = ragPrompt.pipe(model).pipe(new StringOutputParser());
  const generatedAnswer = await ragChain.invoke({
    question: state.question,
    context: context
  });
  
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

  const gradePrompter = ChatPromptTemplate.fromTemplate(
    "You are a grader deciding if a document is relevant to a question.\n\nQuestion: {question}\n\nDocument: {document}\n\nAnswer with a single word: 'yes' or 'no'. Do not return any other text."
  );

  const docGrader = gradePrompter.pipe(model).pipe(new StringOutputParser());
  const relevantDocs: Document[] = [];

  for (const doc of docs) {
    const result = await docGrader.invoke({
      question: state.question,
      document: doc.pageContent,
    });

    if (String(result).toLowerCase().includes("yes")) {
      relevantDocs.push(doc);
    }
  }

  console.log(`[documentGrader] Found ${relevantDocs.length} relevant document(s) out of ${docs.length}`);
  return { ...state, documents: relevantDocs, model };
};

export async function buildVectorStore(urls: string[]) {
  const docs = await Promise.all(
    urls.map(async (url) => {
      const loader = new CheerioWebBaseLoader(url);
      return loader.load();
    })
  );

  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 250,
    chunkOverlap: 20,
  });

  const splitDocs = await textSplitter.splitDocuments(docs.flat());

  const embeddings = new HuggingFaceTransformersEmbeddings({
    model: "Xenova/all-MiniLM-L6-v2",
  });

  const vectorStore = new MemoryVectorStore(embeddings);
  await vectorStore.addDocuments(splitDocs);
  
  return vectorStore;
}

export async function retrieveDoc(
  urls: string[],
  question: string
): Promise<{ documents: Document[] }> {
  const vectorStoreInstance = await buildVectorStore(urls);
  const retrievedDocs = await vectorStoreInstance
    .asRetriever()
    .invoke(question);

  return { documents: retrievedDocs };
}

// Node function for LangGraph that takes state
const retrieveDocNode = async (state: GraphInterface) => {
  const urls = state.urls ?? [];
  console.log(`[retrieveDocNode] Retrieving documents for question: "${state.question}" from ${urls.length} URL(s)`);
  const result = await retrieveDoc(urls, state.question);
  console.log(`[retrieveDocNode] Retrieved ${result.documents.length} document(s) from vector store`);
  return { documents: result.documents };
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
  model: Annotation<ChatOpenAI>({
    reducer: (x: ChatOpenAI, y: ChatOpenAI) => y ?? x,
    default: () => undefined as any,
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
