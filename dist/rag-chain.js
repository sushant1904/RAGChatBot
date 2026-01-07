"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.graph = void 0;
exports.buildVectorStore = buildVectorStore;
exports.retrieveDoc = retrieveDoc;
exports.formatDocuments = formatDocuments;
const prompts_1 = require("@langchain/core/prompts");
const openai_1 = require("@langchain/openai");
const cheerio_1 = require("@langchain/community/document_loaders/web/cheerio");
const textsplitters_1 = require("@langchain/textsplitters");
const memory_1 = require("langchain/vectorstores/memory");
const hf_transformers_1 = require("@langchain/community/embeddings/hf_transformers");
const output_parsers_1 = require("@langchain/core/output_parsers");
const langgraph_1 = require("@langchain/langgraph");
const createModel = async () => {
    return new openai_1.ChatOpenAI({
        model: "gpt-4.1",
        temperature: 0,
        apiKey: process.env.OPENAI_API_KEY,
    });
};
const gradeGeneratedAnswer = async (state) => {
    const model = state.model ?? (await createModel());
    const gradePrompter = prompts_1.ChatPromptTemplate.fromTemplate("You are a grader deciding if a generated answer is relevant to a question.\n\nQuestion:\n{question}\n\nGenerated Answer:\n{generatedAnswer}\n\nAnswer with a single word: 'yes' or 'no'.");
    const graderChain = gradePrompter.pipe(model).pipe(new output_parsers_1.StringOutputParser());
    const result = await graderChain.invoke({
        question: state.question,
        generatedAnswer: state.generatedAnswer ?? "",
    });
    if (String(result).toLowerCase().includes("no")) {
        return { gradeGeneratedAnswer: "Sorry, I don't know the answer to that question." };
    }
    return state;
};
const generateAnswer = async (state) => {
    const model = state.model ?? (await createModel());
    const documents = (state.documents ?? []);
    // Create RAG prompt template
    const ragPrompt = prompts_1.ChatPromptTemplate.fromTemplate("You are an assistant for question-answering tasks. Use the following pieces of retrieved context to answer the question. If you don't know the answer, just say that you don't know. Use three sentences maximum and keep the answer concise.\n\nContext:\n{context}\n\nQuestion: {question}\n\nAnswer:");
    // Format documents as context string
    const context = documents.map(doc => doc.pageContent).join("\n\n");
    const ragChain = ragPrompt.pipe(model).pipe(new output_parsers_1.StringOutputParser());
    const generatedAnswer = await ragChain.invoke({
        question: state.question,
        context: context
    });
    return { generatedAnswer };
};
const hasRelevantDocs = (state) => {
    const relevantDocs = (state.documents ?? []);
    if (relevantDocs.length == 0) {
        return "no";
    }
    return "yes";
};
const documentGrader = async (state) => {
    const docs = (state.documents ?? []);
    const model = state.model ?? (await createModel());
    console.log(`[documentGrader] Grading ${docs.length} document(s) for relevance`);
    const gradePrompter = prompts_1.ChatPromptTemplate.fromTemplate("You are a grader deciding if a document is relevant to a question.\n\nQuestion: {question}\n\nDocument: {document}\n\nAnswer with a single word: 'yes' or 'no'. Do not return any other text.");
    const docGrader = gradePrompter.pipe(model).pipe(new output_parsers_1.StringOutputParser());
    const relevantDocs = [];
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
async function buildVectorStore(urls) {
    const docs = await Promise.all(urls.map(async (url) => {
        const loader = new cheerio_1.CheerioWebBaseLoader(url);
        return loader.load();
    }));
    const textSplitter = new textsplitters_1.RecursiveCharacterTextSplitter({
        chunkSize: 250,
        chunkOverlap: 20,
    });
    const splitDocs = await textSplitter.splitDocuments(docs.flat());
    const embeddings = new hf_transformers_1.HuggingFaceTransformersEmbeddings({
        model: "Xenova/all-MiniLM-L6-v2",
    });
    const vectorStore = new memory_1.MemoryVectorStore(embeddings);
    await vectorStore.addDocuments(splitDocs);
    return vectorStore;
}
async function retrieveDoc(urls, question) {
    const vectorStoreInstance = await buildVectorStore(urls);
    const retrievedDocs = await vectorStoreInstance
        .asRetriever()
        .invoke(question);
    return { documents: retrievedDocs };
}
// Node function for LangGraph that takes state
const retrieveDocNode = async (state) => {
    const urls = state.urls ?? [];
    console.log(`[retrieveDocNode] Retrieving documents for question: "${state.question}" from ${urls.length} URL(s)`);
    const result = await retrieveDoc(urls, state.question);
    console.log(`[retrieveDocNode] Retrieved ${result.documents.length} document(s) from vector store`);
    return { documents: result.documents };
};
// Node function for LangGraph that creates model
const createModelNode = async (state) => {
    const model = await createModel();
    return { model };
};
function formatDocuments(docs) {
    return docs.map((doc) => doc.pageContent);
}
// Define the state schema for LangGraph using Annotation
const GraphState = langgraph_1.Annotation.Root({
    question: (langgraph_1.Annotation),
    urls: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y ?? x,
        default: () => [],
    }),
    generatedAnswer: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y || x,
        default: () => "",
    }),
    documents: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y ?? x,
        default: () => [],
    }),
    model: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y ?? x,
        default: () => undefined,
    }),
});
exports.graph = new langgraph_1.StateGraph(GraphState)
    .addNode("retrieve_documents", retrieveDocNode)
    .addNode("create_model", createModelNode)
    .addNode("grade_documents", documentGrader)
    .addNode("generate_answer", generateAnswer)
    .addNode("grade_generated_answer", gradeGeneratedAnswer)
    .addEdge(langgraph_1.START, "retrieve_documents")
    .addEdge("retrieve_documents", "create_model")
    .addEdge("create_model", "grade_documents")
    .addConditionalEdges("grade_documents", hasRelevantDocs, {
    "yes": "generate_answer",
    "no": langgraph_1.END,
})
    .addEdge("generate_answer", "grade_generated_answer")
    .addEdge("grade_generated_answer", langgraph_1.END)
    .compile();
