# Claudia

A local AI second brain. Upload your PDFs, images, notes, and lecture recordings — then chat with them, generate flashcards, get summaries, and quiz yourself. Everything runs on your machine. Nothing goes to the cloud.

**Stack:** Ollama (llama3.2 + nomic-embed-text) · ChromaDB · faster-whisper · FastAPI · Next.js

---

## Get started

### 1. Clone

```bash
git clone https://github.com/noahsong0222/claudia.git
cd claudia
```

### 2. Install prerequisites

You need three things on your machine first:

| Tool | Why | Install |
|---|---|---|
| [Ollama](https://ollama.ai) | Runs the LLM + embeddings locally | Download from ollama.ai |
| Python 3.10+ | Backend | python.org or `brew install python` |
| Node.js 18+ | Frontend | nodejs.org or `brew install node` |
| Tesseract | OCR for scanned PDFs / images | `brew install tesseract` |
| ffmpeg | Audio/video decoding for transcription | `brew install ffmpeg` |

> On Linux use `apt install tesseract-ocr ffmpeg`. On Windows use the Tesseract and ffmpeg installers, or `winget install`.

Pull the Ollama models (one-time, ~3 GB):

```bash
ollama pull llama3.2
ollama pull nomic-embed-text
```

### 3. Start the backend

```bash
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
python api.py                     # → http://localhost:8000
```

The first audio file you upload downloads the Whisper model (~150 MB) automatically.

### 4. Start the frontend

In a second terminal:

```bash
cd web
npm install
npm run dev                       # → http://localhost:3000
```

Open **http://localhost:3000** and you're in.

---

## How it works (RAG)

1. **Upload** a file in the Library tab. Claudia auto-suggests a class name from the filename — accept it or type your own.
2. The file is extracted to text (PDF text, OCR for images, Whisper for audio/video), chunked, and embedded into a local **ChromaDB** vector database.
3. **Chat** — every question runs retrieval-augmented generation: your query is embedded, the top matching chunks are pulled from ChromaDB, and **llama3.2** answers using only your documents as context.
4. Source chips appear under each answer so you can click straight through to the original file.

No document text ever leaves your machine.

### Grounding — answers come from your notes, not the model

Claudia is built to **not make things up**. Two safeguards keep every answer tied to your documents:

1. **Relevance gate** — before the model runs, Claudia checks how well your question matches anything in the library. If the best match is too weak (below a cosine-similarity floor of `0.25`), it skips the model entirely and replies *"I couldn't find that in your notes."* So asking an off-topic question can't pull in unrelated context.
2. **Strict prompt** — when the model does answer, it's instructed to use *only* the retrieved excerpts, never outside knowledge, to cite the source filename, and to say plainly when something isn't covered.

If Claudia refuses a question you know is in your notes, lower `RELEVANCE_FLOOR` in `rag.py`. If it answers things it shouldn't, raise it (toward `0.35`).

---

## Supported file types

| Type | Formats | How it's read |
|---|---|---|
| Documents | `.pdf` `.docx` | Direct text extraction (OCR fallback for scanned PDFs) |
| Images | `.png` `.jpg` `.jpeg` `.webp` | Tesseract OCR |
| Audio / video | `.mp3` `.mp4` `.wav` `.m4a` `.webm` `.ogg` `.flac` `.mov` `.mkv` | faster-whisper transcription (fully local) |

---

## Tags & auto-tagging

- **Auto-class** — drop a file and Claudia guesses its class from the filename via the LLM, so you rarely type it yourself.
- **Tags** — add free-form tags (chips) at upload time, or edit them later by hovering a file in the Library and clicking **tags**.
- **Filter** — click any `#tag` pill at the top of the Library to filter to just those files.

Tags are stored in ChromaDB metadata and searchable from the Library search box.

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
| `/stats` | Per-class breakdown of files, chunks, and tags |
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
- **File viewer** — click any file to preview PDFs inline, view images, or read transcripts
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
├── api.py            # FastAPI backend (all endpoints)
├── ingest.py         # Ingestion: PDF, image (OCR), DOCX, audio (Whisper) → ChromaDB
├── rag.py            # Vector search + LLM pipeline
├── requirements.txt  # Python dependencies
├── db/               # ChromaDB persistent store
├── uploads/          # Uploaded files served as static assets
└── web/
    └── app/
        ├── page.tsx              # Main UI (chat, library, graph, docs)
        ├── globals.css           # Purple/dark theme
        └── components/
            ├── Graph.tsx         # D3 knowledge graph
            └── FileViewer.tsx    # File preview panel
```

---

## Troubleshooting

- **`ollama: connection refused`** — make sure Ollama is running (`ollama serve` or the desktop app).
- **Audio upload hangs** — the first one downloads the Whisper model; give it a minute. Check `ffmpeg -version` works.
- **Scanned PDF returns no text** — install Tesseract (`brew install tesseract`) so OCR fallback can run.
- **Port already in use** — kill the stray process (`lsof -ti:3000 | xargs kill`) or change the port.
