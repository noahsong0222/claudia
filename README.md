# Claudia

A local AI second brain. Upload your PDFs, images, and notes — then chat with them, generate flashcards, get summaries, and quiz yourself. Everything runs on your machine. Nothing goes to the cloud.

**Stack:** Ollama (llama3.2 + nomic-embed-text) · ChromaDB · FastAPI · Next.js

---

## Requirements

- [Ollama](https://ollama.ai) running locally
- Python 3.10+
- Node.js 18+

Pull the models first:

```bash
ollama pull llama3.2
ollama pull nomic-embed-text
```

---

## Setup

**Backend**

```bash
cd claudia
python -m venv venv
source venv/bin/activate
pip install fastapi uvicorn chromadb langchain-ollama langchain-text-splitters \
            langchain-core pypdf python-docx pillow pytesseract pymupdf numpy
python api.py
# → http://localhost:8000
```

**Frontend**

```bash
cd web
npm install
npm run dev
# → http://localhost:3000
```

Open `http://localhost:3000`.

---

## How it works

1. **Upload** a PDF, image, or DOCX in the Library tab — tag it with a class name (e.g. "Biology 101")
2. Claudia chunks and embeds it into a local ChromaDB vector database
3. **Chat** — every question runs RAG: your query is embedded, the top matching chunks are retrieved, and llama3.2 answers using only your documents as context
4. Source chips appear under each answer so you can click through to the original file

---

## Slash commands

| Command | What it does |
|---|---|
| `/summary [file\|class]` | Stream a summary of a file, class, or everything |
| `/outline [file\|class]` | Hierarchical Roman-numeral outline |
| `/flashcards [file\|class] [n]` | Generate n flip cards (default 10) |
| `/quiz [file\|class] [n]` | Multiple-choice quiz with explanations |
| `/explain <topic>` | Deep-dive explanation using your notes |
| `/search <query>` | Semantic search with relevance scores |
| `/note <text>` | Save a quick note directly to the brain |
| `/stats` | Per-class breakdown of files and chunks |
| `/clear` | Start a new conversation |

All commands are **case-insensitive** and support aliases (`/flash`, `/sum`, `/define`, `/find`, `/jot`, etc.).

Scope any command to a class or file using the **◎ scope picker** in the top-right of chat, or pass a name as an argument:

```
/flashcards Biology 101 15
/summary chapter3.pdf
/quiz Calculus 8
```

---

## Features

- **Conversation history** — chats auto-save to localStorage; restore any past conversation from the sidebar
- **MD export / import** — export a chat as `.md`, import it back later to continue
- **File viewer** — click any file to preview PDFs inline, view images, or read DOCX text
- **Knowledge graph** — force-directed D3 graph showing semantic connections between files
- **Resizable sidebar** — drag the right edge to any width
- **Docs tab** — full in-app reference for every command and feature

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘K` | Focus chat input |
| `⌘U` | Jump to Library |
| `/` | Open command palette |
| `Tab` | Select highlighted command |
| `Space` | Flip flashcard |
| `← →` | Navigate flashcards |
| `Esc` | Close file viewer / palette |

---

## Project structure

```
claudia/
├── api.py          # FastAPI backend (all endpoints)
├── ingest.py       # File ingestion: PDF, image (OCR), DOCX → ChromaDB
├── rag.py          # Vector search + LLM pipeline
├── db/             # ChromaDB persistent store
├── uploads/        # Uploaded files served as static assets
└── web/
    └── app/
        ├── page.tsx              # Main UI (chat, library, graph, docs)
        ├── globals.css           # Purple/dark theme
        └── components/
            ├── Graph.tsx         # D3 knowledge graph
            └── FileViewer.tsx    # File preview panel
```
