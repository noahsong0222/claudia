import json
import tempfile
import shutil
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ingest import ingest_file, get_classes, get_files, _collection, _embeddings, _splitter
from rag import search, get_all_chunks, _llm, _SYSTEM
from langchain_core.messages import HumanMessage, SystemMessage

app = FastAPI(title="Claudia API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOADS_DIR = Path(__file__).parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")


# ── health / meta ──────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "chunks": _collection.count()}


@app.get("/files")
def files():
    return {"files": get_files()}


@app.get("/classes")
def classes():
    return {"classes": get_classes()}


# ── ingest ─────────────────────────────────────────────────────────────────────

@app.post("/ingest")
async def ingest(file: UploadFile = File(...), class_name: str = Form("General")):
    existing = get_files()
    if any(f["filename"] == file.filename for f in existing):
        raise HTTPException(status_code=409, detail=f"'{file.filename}' is already ingested. Delete it first to re-ingest.")

    suffix = Path(file.filename).suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        result = ingest_file(tmp_path, class_name)
        dest = UPLOADS_DIR / file.filename
        Path(tmp_path).rename(dest)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/files/{filename}/text")
def file_text(filename: str):
    path = UPLOADS_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    from ingest import extract_text
    try:
        return {"text": extract_text(path)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/files/{filename}")
def delete_file(filename: str):
    existing = get_files()
    if not any(f["filename"] == filename for f in existing):
        raise HTTPException(status_code=404, detail="File not found")
    results = _collection.get(where={"filename": filename}, include=["metadatas"])
    ids = results["ids"]
    if ids:
        _collection.delete(ids=ids)
    upload_path = UPLOADS_DIR / filename
    if upload_path.exists():
        upload_path.unlink()
    return {"deleted": filename, "chunks_removed": len(ids)}


# ── chat ───────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    question: str
    class_name: str | None = None
    filename: str | None = None


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    if _collection.count() == 0:
        async def empty():
            yield f'data: {json.dumps({"token": "No documents ingested yet."})}\n\n'
            yield f'data: {json.dumps({"done": True, "sources": []})}\n\n'
        return StreamingResponse(empty(), media_type="text/event-stream")

    chunks = search(req.question, class_name=req.class_name, filename=req.filename)
    sources = [c["metadata"] for c in chunks]

    if not chunks:
        async def no_results():
            yield f'data: {json.dumps({"token": "No relevant documents found in this scope."})}\n\n'
            yield f'data: {json.dumps({"done": True, "sources": []})}\n\n'
        return StreamingResponse(no_results(), media_type="text/event-stream")

    context = "\n\n---\n\n".join(
        f"[{c['metadata']['filename']} | {c['metadata'].get('class_name', 'General')}]\n{c['text']}"
        for c in chunks
    )
    messages = [
        SystemMessage(content=_SYSTEM),
        HumanMessage(content=f"Context:\n{context}\n\nQuestion: {req.question}"),
    ]

    async def token_stream():
        for chunk in _llm.stream(messages):
            if chunk.content:
                yield f"data: {json.dumps({'token': chunk.content})}\n\n"
        yield f"data: {json.dumps({'done': True, 'sources': sources})}\n\n"

    return StreamingResponse(token_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── shared scope model ─────────────────────────────────────────────────────────

class ScopeRequest(BaseModel):
    class_name: str | None = None
    filename: str | None = None


# ── /summary ───────────────────────────────────────────────────────────────────

@app.post("/summary")
async def summary(req: ScopeRequest):
    doc_chunks = get_all_chunks(class_name=req.class_name, filename=req.filename)
    if not doc_chunks:
        raise HTTPException(status_code=404, detail="No content found for this scope.")

    sample = doc_chunks if len(doc_chunks) <= 30 else [
        doc_chunks[i] for i in range(0, len(doc_chunks), len(doc_chunks) // 30)
    ][:30]
    context = "\n\n---\n\n".join(sample)
    scope_desc = req.filename or req.class_name or "all documents"

    prompt = (
        f"Below are excerpts from: {scope_desc}\n\n{context}\n\n"
        "Write a clear, well-organized summary. Use bullet points for key facts. "
        "Cover the main topics, important details, and anything worth remembering."
    )
    messages = [
        SystemMessage(content="You are Claudia, a personal AI study assistant. Summarize clearly and concisely."),
        HumanMessage(content=prompt),
    ]

    async def stream():
        for chunk in _llm.stream(messages):
            if chunk.content:
                yield f"data: {json.dumps({'token': chunk.content})}\n\n"
        yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── /outline ───────────────────────────────────────────────────────────────────

@app.post("/outline")
async def outline(req: ScopeRequest):
    doc_chunks = get_all_chunks(class_name=req.class_name, filename=req.filename)
    if not doc_chunks:
        raise HTTPException(status_code=404, detail="No content found for this scope.")

    sample = doc_chunks if len(doc_chunks) <= 25 else [
        doc_chunks[i] for i in range(0, len(doc_chunks), len(doc_chunks) // 25)
    ][:25]
    context = "\n\n---\n\n".join(sample)
    scope_desc = req.filename or req.class_name or "all documents"

    prompt = (
        f"Based on these study notes from: {scope_desc}\n\n{context}\n\n"
        "Create a structured outline with numbered sections and subsections. "
        "Use Roman numerals for top-level sections, letters for subsections. "
        "Each point should be concise but informative. Include all major topics."
    )
    messages = [
        SystemMessage(content="You are Claudia, a study assistant. Create clean, hierarchical outlines."),
        HumanMessage(content=prompt),
    ]

    async def stream():
        for chunk in _llm.stream(messages):
            if chunk.content:
                yield f"data: {json.dumps({'token': chunk.content})}\n\n"
        yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── /explain ───────────────────────────────────────────────────────────────────

class ExplainRequest(BaseModel):
    topic: str
    class_name: str | None = None
    filename: str | None = None
    level: str = "normal"  # simple | normal | deep


@app.post("/explain")
async def explain(req: ExplainRequest):
    chunks = search(req.topic, n=8, class_name=req.class_name, filename=req.filename)
    if not chunks:
        raise HTTPException(status_code=404, detail="No relevant content found.")

    context = "\n\n---\n\n".join(
        f"[{c['metadata']['filename']}]\n{c['text']}" for c in chunks
    )

    level_instruction = {
        "simple": "Explain as if to a complete beginner. Use analogies, avoid jargon.",
        "normal": "Explain clearly for a student learning the topic.",
        "deep": "Give a thorough, technical explanation with nuance and edge cases.",
    }.get(req.level, "Explain clearly for a student learning the topic.")

    prompt = (
        f"Using these notes, explain: {req.topic}\n\n"
        f"{context}\n\n"
        f"{level_instruction}"
    )
    messages = [
        SystemMessage(content="You are Claudia, a personal tutor. Explain concepts using the student's own notes."),
        HumanMessage(content=prompt),
    ]

    async def stream():
        for chunk in _llm.stream(messages):
            if chunk.content:
                yield f"data: {json.dumps({'token': chunk.content})}\n\n"
        yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── /quiz ──────────────────────────────────────────────────────────────────────

class QuizRequest(BaseModel):
    class_name: str | None = None
    filename: str | None = None
    count: int = 5


@app.post("/quiz")
def quiz(req: QuizRequest):
    doc_chunks = get_all_chunks(class_name=req.class_name, filename=req.filename)
    if not doc_chunks:
        raise HTTPException(status_code=404, detail="No content found for this scope.")

    sample = doc_chunks if len(doc_chunks) <= 20 else [
        doc_chunks[i] for i in range(0, len(doc_chunks), len(doc_chunks) // 20)
    ][:20]
    context = "\n\n---\n\n".join(sample)

    prompt = (
        f"Based on these notes, create {req.count} multiple-choice quiz questions.\n\n"
        f"{context}\n\n"
        "Return ONLY a JSON array. Format:\n"
        '[{"q": "question", "options": ["A) ...", "B) ...", "C) ...", "D) ..."], "answer": "A", "explanation": "why"}]\n'
        "Make questions test real understanding, not just memorization."
    )
    messages = [
        SystemMessage(content="You are a quiz generator. Output only valid JSON arrays."),
        HumanMessage(content=prompt),
    ]
    response = _llm.invoke(messages)

    text = response.content.strip()
    start = text.find("[")
    end = text.rfind("]") + 1
    if start == -1 or end == 0:
        raise HTTPException(status_code=500, detail="Model did not return valid quiz JSON.")
    try:
        questions = json.loads(text[start:end])
        return {"questions": questions, "count": len(questions)}
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Could not parse quiz JSON.")


# ── /search ────────────────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    class_name: str | None = None
    filename: str | None = None
    n: int = 8


@app.post("/search")
def semantic_search(req: SearchRequest):
    results = search(req.query, n=req.n, class_name=req.class_name, filename=req.filename)
    return {
        "results": [
            {
                "text": r["text"],
                "filename": r["metadata"]["filename"],
                "class_name": r["metadata"].get("class_name", "General"),
                "chunk_index": r["metadata"].get("chunk_index", 0),
                "score": round(1 - r["distance"], 3),
            }
            for r in results
        ],
        "count": len(results),
    }


# ── /stats ─────────────────────────────────────────────────────────────────────

@app.get("/stats")
def stats():
    all_files = get_files()
    all_classes = get_classes()
    total_chunks = _collection.count()

    by_class: dict[str, dict] = {}
    for f in all_files:
        cn = f.get("class_name", "General")
        if cn not in by_class:
            by_class[cn] = {"files": 0, "chunks": 0}
        by_class[cn]["files"] += 1

    if total_chunks > 0:
        result = _collection.get(include=["metadatas"])
        for meta in result["metadatas"]:
            cn = meta.get("class_name", "General")
            if cn in by_class:
                by_class[cn]["chunks"] += 1

    return {
        "total_chunks": total_chunks,
        "total_files": len(all_files),
        "total_classes": len(all_classes),
        "by_class": by_class,
    }


# ── /flashcards ────────────────────────────────────────────────────────────────

class FlashcardRequest(BaseModel):
    class_name: str | None = None
    filename: str | None = None
    count: int = 10


@app.post("/flashcards")
def flashcards(req: FlashcardRequest):
    doc_chunks = get_all_chunks(class_name=req.class_name, filename=req.filename)
    if not doc_chunks:
        raise HTTPException(status_code=404, detail="No content found for this scope.")

    sample = doc_chunks if len(doc_chunks) <= 20 else [
        doc_chunks[i] for i in range(0, len(doc_chunks), len(doc_chunks) // 20)
    ][:20]
    context = "\n\n---\n\n".join(sample)

    prompt = (
        f"Based on these study notes, generate exactly {req.count} flashcards.\n\n"
        f"{context}\n\n"
        "Return ONLY a JSON array, no other text. Format:\n"
        '[{"q": "question", "a": "answer"}, ...]\n'
        "Make questions specific and testable. Answers concise but complete."
    )
    messages = [
        SystemMessage(content="You are a study assistant. Output only valid JSON arrays."),
        HumanMessage(content=prompt),
    ]
    response = _llm.invoke(messages)

    text = response.content.strip()
    start = text.find("[")
    end = text.rfind("]") + 1
    if start == -1 or end == 0:
        raise HTTPException(status_code=500, detail="Model did not return valid flashcards.")
    try:
        cards = json.loads(text[start:end])
        return {"cards": cards, "count": len(cards)}
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Could not parse flashcard JSON.")


# ── /note ──────────────────────────────────────────────────────────────────────

class NoteRequest(BaseModel):
    text: str
    class_name: str = "General"
    title: str = ""


@app.post("/note")
def note(req: NoteRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Note text is empty.")

    title = req.title.strip() or f"note-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    ingested_at = datetime.now().isoformat(timespec="seconds")

    chunks = _splitter.split_text(req.text)
    vectors = _embeddings.embed_documents(chunks)
    ids = [str(uuid.uuid4()) for _ in chunks]
    metadatas = [
        {"filename": title, "class_name": req.class_name,
         "ingested_at": ingested_at, "chunk_index": i, "type": "note"}
        for i in range(len(chunks))
    ]
    _collection.add(ids=ids, embeddings=vectors, documents=chunks, metadatas=metadatas)
    return {"title": title, "class_name": req.class_name, "chunk_count": len(chunks)}


# ── /graph ─────────────────────────────────────────────────────────────────────

@app.get("/graph")
def graph():
    import numpy as np
    if _collection.count() == 0:
        return {"nodes": [], "edges": []}

    result = _collection.get(include=["embeddings", "metadatas"])
    embeddings = np.array(result["embeddings"])
    metadatas = result["metadatas"]

    file_chunks: dict[str, list[int]] = {}
    file_meta: dict[str, dict] = {}
    for i, m in enumerate(metadatas):
        fn = m["filename"]
        file_chunks.setdefault(fn, []).append(i)
        file_meta[fn] = {"filename": fn, "class_name": m.get("class_name", "General")}

    filenames = list(file_chunks.keys())

    def centroid(idxs):
        vecs = embeddings[idxs]
        c = vecs.mean(axis=0)
        norm = np.linalg.norm(c)
        return c / norm if norm > 0 else c

    centroids = {fn: centroid(idxs) for fn, idxs in file_chunks.items()}
    edges = []
    if len(filenames) >= 2:
        for i in range(len(filenames)):
            for j in range(i + 1, len(filenames)):
                a, b = filenames[i], filenames[j]
                sim = float(np.dot(centroids[a], centroids[b]))
                if sim > 0.3:
                    edges.append({"source": a, "target": b, "weight": round(sim, 3)})

    classes = list({file_meta[fn]["class_name"] for fn in filenames})
    class_nodes = [{"id": c, "type": "class"} for c in classes]
    file_nodes = [{"id": fn, "type": "file", "class_name": file_meta[fn]["class_name"], "chunk_count": len(file_chunks[fn])} for fn in filenames]
    class_edges = [{"source": fn, "target": file_meta[fn]["class_name"], "weight": 0.5} for fn in filenames]

    return {"nodes": file_nodes + class_nodes, "edges": edges + class_edges}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
