"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const rag_chain_1 = require("./rag-chain");
const app = (0, express_1.default)();
const PORT = 3000;
// Middleware
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.static(path_1.default.join(__dirname, "public")));
// API endpoint to process queries
app.post("/api/query", async (req, res) => {
    try {
        const { urls, question } = req.body;
        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ error: "Please provide at least one URL" });
        }
        if (!question || question.trim() === "") {
            return res.status(400).json({ error: "Please provide a question" });
        }
        console.log(`Processing query: "${question}" for URLs:`, urls);
        const result = await rag_chain_1.graph.invoke({ question, urls });
        console.log("Graph result:", {
            documentCount: result.documents?.length ?? 0,
            hasGeneratedAnswer: !!result.generatedAnswer,
        });
        const formattedDocs = (0, rag_chain_1.formatDocuments)(result.documents ?? []);
        res.json({
            success: true,
            question,
            documents: formattedDocs,
            documentCount: formattedDocs.length,
            generatedAnswer: result.generatedAnswer,
        });
    }
    catch (error) {
        console.error("Error processing query:", error);
        res.status(500).json({
            error: "Failed to process query",
            message: error.message,
        });
    }
});
// Serve the HTML file
app.get("/", (req, res) => {
    res.sendFile(path_1.default.join(__dirname, "public", "index.html"));
});
app.listen(PORT, () => {
    console.log(`🚀 RAG Agent server running at http://localhost:${PORT}`);
    console.log(`📝 Open your browser and navigate to http://localhost:${PORT}`);
});
