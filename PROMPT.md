# RAG Chatbot Build Prompt

Use this prompt to generate a local-first RAG chatbot app with URL + file uploads, local embeddings, and a local LLM.

---

## Prompt

Build a full-stack RAG chatbot web app with the following requirements:

### Tech Stack
- Node.js + TypeScript backend
- Express API server
- LangChain + LangGraph for the RAG pipeline
- Local LLM via Ollama (use `qwen2.5:3b`)
- Local embeddings via HuggingFace Transformers (use `Xenova/bge-small-en-v1.5`)
- Frontend: single static `public/index.html` with embedded JS + CSS

### Core Features
- Chat UI with:
  - Left sidebar for inputs (URLs, file uploads, settings)
  - Center chat area only (messages + input box)
  - A top bar in the chat area with the app title
- Support both:
  - URL ingestion (max 3 URLs at a time)
  - File uploads (txt, md, csv, json, pdf), multiple files
  - Query across URLs + uploads together
- Suggested questions:
  - Generate with local LLM
  - Use embeddings to pick representative chunks first
  - Return top 3 suggestions
  - Avoid junk like `json`, `[`, `]`
- Greeting handling and simple conversational replies
- Vector store caching keyed by URL set + upload IDs + rag config

### RAG Pipeline
- Split documents with a recursive splitter
  - Use separators: `["\n\n", "\n", ". ", " ", ""]`
  - Keep separators in chunks
  - Auto-tune chunk size based on average doc length
  - Default chunk size ~700 with ~20% overlap
- Retrieval:
  - Default to similarity search
  - Use k=12, fetchK=40, lambda=0.6 (configurable)
- Graph flow (LangGraph):
  - `retrieve_documents` → `create_model` → `grade_documents` → `generate_answer` → `grade_generated_answer`
  - Use the local LLM for grading + answering

### Advanced RAG Settings
- Add an "Advanced RAG Settings" button in the sidebar
- Open a modal popup with:
  - chunk size, overlap
  - retriever strategy (default / mmr / similarity)
  - retriever k, fetchK, lambda
  - Save + Reset buttons
  - Quick guides:
    - General QA: chunk 700, overlap 20%, similarity, k 12
    - Summarization: chunk 900, overlap 20%, MMR, k 12, fetchK 40, lambda 0.5
    - Fact lookup: chunk 500, overlap 10%, similarity, k 6

### API Endpoints
- `POST /api/chat`
- `POST /api/sample-questions`
- `POST /api/upload` (multipart/form-data, files[])
- `DELETE /api/uploads/clear`
- `GET /api/health`
- `GET /api/cpu-usage`

### Deployment & Docker
- Provide a Dockerfile using `node:20-slim` for glibc compatibility
- Build stage: install deps, run `npm run build`, prune dev deps
- Runtime stage: copy `dist` and `dist/public`

### UX Details
- Suggested questions rendered as clickable chips
- "Setup URLs" button and upload buttons in sidebar cards
- Keep UI modern with dark sidebar + light chat area

### Extra Requirements
- Use `multer` for uploads and `pdf-parse` for PDFs
- Use memory vector store for now
- Ensure Ollama is running locally to answer questions

Deliverables:
- `server.ts`, `rag-chain.ts`, `public/index.html`, `package.json`, `Dockerfile`, `README.md`
- Provide clean UI styling and working chat UX
- All code should be runnable locally

---

## Notes
- The app should work without any external API keys.
- The only external runtime dependency is Ollama.
