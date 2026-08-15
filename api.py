import json
import tempfile
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import List

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ingest import (
    ingest_file, get_classes, get_files, get_all_tags, update_file_tags,
    extract_preview, decode_tags, invalidate_cache, AUDIO_EXTS,
    _collection, _embeddings, _splitter,
)
from rag import search, get_all_chunks, _llm, _SYSTEM, RELEVANCE_FLOOR, NOT_FOUND_MSG
import style as style_studio
import homework as hw
from langchain_core.messages import HumanMessage, SystemMessage

app = FastAPI(title="Claudia API")


@app.exception_handler(Exception)
async def unhandled_exception(request, exc):
    """Always return JSON (never bare 'Internal Server Error' text) so the
    frontend can show a real message. Detect the #1 failure: Ollama down."""
    from fastapi.responses import JSONResponse
    msg = str(exc)
    if "Connection refused" in msg or "ConnectError" in type(exc).__name__:
        return JSONResponse(status_code=503, content={
            "detail": "Can't reach Ollama — open the Ollama app (or run 'ollama serve') and try again."
        })
    return JSONResponse(status_code=500, content={"detail": f"Server error: {msg[:200]}"})


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


@app.get("/tags")
def tags():
    return {"tags": get_all_tags()}


# ── ingest ─────────────────────────────────────────────────────────────────────

@app.post("/ingest")
async def ingest(
    file: UploadFile = File(...),
    class_name: str = Form("General"),
    tags: str = Form(""),            # comma-separated tag string from form
):
    existing = get_files()
    if any(f["filename"] == file.filename for f in existing):
        raise HTTPException(status_code=409, detail=f"'{file.filename}' is already ingested. Delete it first to re-ingest.")

    suffix = Path(file.filename).suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    tag_list = [t.strip() for t in tags.split(",") if t.strip()]

    try:
        result = ingest_file(tmp_path, class_name, tag_list)
        dest = UPLOADS_DIR / file.filename
        Path(tmp_path).rename(dest)
        return result
    except Exception as e:
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=str(e))


# ── auto-tag suggestion ────────────────────────────────────────────────────────

class SuggestRequest(BaseModel):
    filename: str
    existing_classes: list[str] = []


@app.post("/suggest-class")
async def suggest_class(req: SuggestRequest):
    """
    Given a filename (and optionally a text preview after upload),
    ask the LLM to suggest the most fitting class name.
    """
    existing = ", ".join(req.existing_classes) if req.existing_classes else "none yet"
    prompt = (
        f"A student is uploading a file named: {req.filename!r}\n\n"
        f"Existing class/subject names in their library: {existing}\n\n"
        "Suggest the most likely academic subject or class name for this file. "
        "If it matches an existing class name, return that exact name. "
        "Otherwise suggest a short, clean name (e.g. 'Biology 101', 'AP Chemistry', 'History Notes'). "
        "Reply with ONLY the class name, nothing else."
    )
    messages = [
        SystemMessage(content="You are a helpful assistant that categorizes academic files."),
        HumanMessage(content=prompt),
    ]
    response = _llm.invoke(messages)
    suggestion = response.content.strip().strip('"').strip("'")
    return {"suggestion": suggestion}


# ── file operations ────────────────────────────────────────────────────────────

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
        invalidate_cache()
    upload_path = UPLOADS_DIR / filename
    if upload_path.exists():
        upload_path.unlink()
    return {"deleted": filename, "chunks_removed": len(ids)}


# ── tag management ─────────────────────────────────────────────────────────────

class TagUpdateRequest(BaseModel):
    tags: list[str]


@app.put("/files/{filename}/tags")
def update_tags(filename: str, req: TagUpdateRequest):
    existing = get_files()
    if not any(f["filename"] == filename for f in existing):
        raise HTTPException(status_code=404, detail="File not found")
    count = update_file_tags(filename, req.tags)
    return {"filename": filename, "tags": req.tags, "chunks_updated": count}


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

    # Relevance gate: if nothing retrieved, or the best match is too weak, refuse
    # instead of feeding the LLM off-topic context it would hallucinate from.
    best_score = max((1 - c["distance"] for c in chunks), default=0.0)
    if not chunks or best_score < RELEVANCE_FLOOR:
        async def no_results():
            yield f'data: {json.dumps({"token": NOT_FOUND_MSG})}\n\n'
            yield f'data: {json.dumps({"done": True, "sources": [], "confidence": None})}\n\n'
        return StreamingResponse(no_results(), media_type="text/event-stream")

    # "Show your work": ship the exact retrieved chunks, their similarity scores,
    # and an honest confidence estimate derived from those scores.
    sources = [
        {
            "filename":    c["metadata"]["filename"],
            "class_name":  c["metadata"].get("class_name", "General"),
            "chunk_index": c["metadata"].get("chunk_index", 0),
            "score":       round(1 - c["distance"], 3),
            "text":        c["text"][:400] + ("…" if len(c["text"]) > 400 else ""),
        }
        for c in chunks
    ]
    confidence = _confidence_from_scores([s["score"] for s in sources])

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
        yield f"data: {json.dumps({'done': True, 'sources': sources, 'confidence': confidence})}\n\n"

    return StreamingResponse(token_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _confidence_from_scores(scores: list[float]) -> dict:
    """Honest confidence estimate from retrieval similarity scores.

    best score drives the label; coverage (how many strong chunks) adds nuance.
    Returned to the UI so every answer can show how well-grounded it is.
    """
    if not scores:
        return {"score": 0.0, "label": "Low", "note": "No supporting notes found."}
    best = max(scores)
    strong = sum(1 for s in scores if s >= 0.45)
    if best >= 0.6:
        label = "High"
    elif best >= 0.45:
        label = "Medium"
    else:
        label = "Low"
    if strong <= 1 or best < 0.5:
        note = "Your notes are thin on this — double-check the answer."
    else:
        note = "Well supported by your notes."
    return {"score": round(best, 2), "label": label, "strong_sources": strong, "note": note}


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
    level: str = "normal"


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
        "deep":   "Give a thorough, technical explanation with nuance and edge cases.",
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
    start, end = text.find("["), text.rfind("]") + 1
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
                "text":        r["text"],
                "filename":    r["metadata"]["filename"],
                "class_name":  r["metadata"].get("class_name", "General"),
                "chunk_index": r["metadata"].get("chunk_index", 0),
                "score":       round(1 - r["distance"], 3),
            }
            for r in results
        ],
        "count": len(results),
    }


# ── /stats ─────────────────────────────────────────────────────────────────────

@app.get("/stats")
def stats():
    all_files   = get_files()
    all_classes = get_classes()
    all_tags    = get_all_tags()
    total_chunks = _collection.count()

    # chunk_count comes from the cached rollup — no second full scan needed.
    by_class: dict[str, dict] = {}
    for f in all_files:
        cn = f.get("class_name", "General")
        if cn not in by_class:
            by_class[cn] = {"files": 0, "chunks": 0}
        by_class[cn]["files"] += 1
        by_class[cn]["chunks"] += f.get("chunk_count", 0)

    audio_files = sum(1 for f in all_files if f.get("file_type") == "audio")

    return {
        "total_chunks":  total_chunks,
        "total_files":   len(all_files),
        "total_classes": len(all_classes),
        "total_tags":    len(all_tags),
        "audio_files":   audio_files,
        "by_class":      by_class,
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
    start, end = text.find("["), text.rfind("]") + 1
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
    tags: list[str] = []


@app.post("/note")
def note(req: NoteRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Note text is empty.")

    title      = req.title.strip() or f"note-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    ingested_at = datetime.now().isoformat(timespec="seconds")
    from ingest import encode_tags
    tags_str   = encode_tags(req.tags)

    chunks  = _splitter.split_text(req.text)
    vectors = _embeddings.embed_documents(chunks)
    ids     = [str(uuid.uuid4()) for _ in chunks]
    metadatas = [
        {
            "filename":    title,
            "class_name":  req.class_name,
            "ingested_at": ingested_at,
            "chunk_index": i,
            "tags":        tags_str,
            "file_type":   "note",
        }
        for i in range(len(chunks))
    ]
    _collection.add(ids=ids, embeddings=vectors, documents=chunks, metadatas=metadatas)
    invalidate_cache()
    return {"title": title, "class_name": req.class_name, "tags": req.tags, "chunk_count": len(chunks)}


# ── /graph ─────────────────────────────────────────────────────────────────────

@app.get("/graph")
def graph():
    import numpy as np
    if _collection.count() == 0:
        return {"nodes": [], "edges": []}

    result    = _collection.get(include=["embeddings", "metadatas"])
    embeddings = np.array(result["embeddings"])
    metadatas  = result["metadatas"]

    file_chunks: dict[str, list[int]] = {}
    file_meta:   dict[str, dict]      = {}
    for i, m in enumerate(metadatas):
        fn = m["filename"]
        file_chunks.setdefault(fn, []).append(i)
        file_meta[fn] = {
            "filename":  fn,
            "class_name": m.get("class_name", "General"),
            "tags":       decode_tags(m.get("tags", "")),
            "file_type":  m.get("file_type", "document"),
        }

    filenames = list(file_chunks.keys())

    def centroid(idxs):
        vecs = embeddings[idxs]
        c    = vecs.mean(axis=0)
        norm = np.linalg.norm(c)
        return c / norm if norm > 0 else c

    centroids = {fn: centroid(idxs) for fn, idxs in file_chunks.items()}
    edges = []
    if len(filenames) >= 2:
        for i in range(len(filenames)):
            for j in range(i + 1, len(filenames)):
                a, b = filenames[i], filenames[j]
                sim  = float(np.dot(centroids[a], centroids[b]))
                if sim > 0.3:
                    edges.append({"source": a, "target": b, "weight": round(sim, 3)})

    classes     = list({file_meta[fn]["class_name"] for fn in filenames})
    class_nodes = [{"id": c, "type": "class"} for c in classes]
    file_nodes  = [
        {
            "id":          fn,
            "type":        "file",
            "class_name":  file_meta[fn]["class_name"],
            "tags":        file_meta[fn]["tags"],
            "file_type":   file_meta[fn]["file_type"],
            "chunk_count": len(file_chunks[fn]),
        }
        for fn in filenames
    ]
    class_edges = [{"source": fn, "target": file_meta[fn]["class_name"], "weight": 0.5} for fn in filenames]

    return {"nodes": file_nodes + class_nodes, "edges": edges + class_edges}


# ── Style Studio ───────────────────────────────────────────────────────────────
# Analyze the user's writing and generate text in their voice. Fully separate
# from the notes RAG — samples + profile live in style/*.json.

class StyleSample(BaseModel):
    title: str = ""
    text: str


class StyleGenRequest(BaseModel):
    task: str
    mode: str = "write"   # "write" | "rewrite"


@app.get("/style/samples")
def style_samples():
    return {"samples": style_studio.list_samples()}


@app.post("/style/samples")
def style_add_sample(req: StyleSample):
    try:
        return style_studio.add_sample(req.title, req.text)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/style/samples/{sample_id}")
def style_delete_sample(sample_id: str):
    if not style_studio.delete_sample(sample_id):
        raise HTTPException(status_code=404, detail="Sample not found")
    return {"deleted": sample_id}


@app.get("/style/metrics")
def style_metrics():
    return style_studio.compute_metrics()


@app.get("/style/profile")
def style_profile():
    return {"profile": style_studio.get_profile()}


OLLAMA_DOWN_MSG = "Can't reach Ollama — open the Ollama app (or run 'ollama serve') and try again."


@app.post("/style/analyze")
def style_analyze():
    try:
        return {"profile": style_studio.build_profile(style_studio.get_style_llm())}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # most common cause: Ollama not running / model missing
        msg = str(e)
        if "Connection refused" in msg or "ConnectError" in type(e).__name__:
            raise HTTPException(status_code=503, detail=OLLAMA_DOWN_MSG)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {msg[:200]}")


@app.post("/style/generate")
async def style_generate(req: StyleGenRequest):
    if not req.task.strip():
        raise HTTPException(status_code=400, detail="Nothing to write.")
    if not style_studio.list_samples():
        raise HTTPException(status_code=400, detail="Add writing samples first so I can learn your voice.")

    messages = style_studio.build_generation_messages(req.task, req.mode)
    style_llm = style_studio.get_style_llm()

    async def stream():
        try:
            for chunk in style_llm.stream(messages):
                if chunk.content:
                    yield f"data: {json.dumps({'token': chunk.content})}\n\n"
        except Exception:
            yield f"data: {json.dumps({'token': OLLAMA_DOWN_MSG})}\n\n"
        yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Homework tracker ───────────────────────────────────────────────────────────

class HomeworkCreate(BaseModel):
    title: str
    class_name: str = ""
    due_date: str = ""      # ISO date "2026-08-20" or ""
    priority: str = "medium"
    notes: str = ""


class HomeworkUpdate(BaseModel):
    title: str | None = None
    class_name: str | None = None
    due_date: str | None = None
    priority: str | None = None
    notes: str | None = None
    status: str | None = None


@app.get("/homework")
def homework_list():
    return {"tasks": hw.list_tasks(), "stats": hw.stats()}


@app.post("/homework")
def homework_add(req: HomeworkCreate):
    try:
        return hw.add_task(req.title, req.class_name, req.due_date, req.priority, req.notes)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.patch("/homework/{task_id}")
def homework_update(task_id: str, req: HomeworkUpdate):
    try:
        task = hw.update_task(task_id, **req.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@app.delete("/homework/{task_id}")
def homework_delete(task_id: str):
    if not hw.delete_task(task_id):
        raise HTTPException(status_code=404, detail="Task not found")
    return {"deleted": task_id}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
