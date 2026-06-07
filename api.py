import tempfile
import shutil
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ingest import ingest_file, get_classes, get_files, _collection
from rag import search, _llm, _SYSTEM
from langchain_core.messages import HumanMessage, SystemMessage

app = FastAPI(title="Claudia API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOADS_DIR = Path(__file__).parent / "uploads"
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")


@app.get("/health")
def health():
    return {"status": "ok", "chunks": _collection.count()}


@app.get("/files")
def files():
    return {"files": get_files()}


@app.get("/classes")
def classes():
    return {"classes": get_classes()}


@app.post("/ingest")
async def ingest(
    file: UploadFile = File(...),
    class_name: str = Form("General"),
):
    # duplicate detection
    existing = get_files()
    if any(f["filename"] == file.filename for f in existing):
        raise HTTPException(status_code=409, detail=f"'{file.filename}' is already ingested. Delete it first to re-ingest.")

    suffix = Path(file.filename).suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        result = ingest_file(tmp_path, class_name)
        dest = Path(tmp_path).parent / file.filename
        Path(tmp_path).rename(dest)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/files/{filename}")
def delete_file(filename: str):
    existing = get_files()
    if not any(f["filename"] == filename for f in existing):
        raise HTTPException(status_code=404, detail="File not found")

    # delete all chunks for this file
    results = _collection.get(where={"filename": filename}, include=["metadatas"])
    ids = results["ids"]
    if ids:
        _collection.delete(ids=ids)

    # remove from uploads dir
    upload_path = Path(__file__).parent / "uploads" / filename
    if upload_path.exists():
        upload_path.unlink()

    return {"deleted": filename, "chunks_removed": len(ids)}


class ChatRequest(BaseModel):
    question: str
    class_name: str | None = None


@app.post("/chat")
def chat(req: ChatRequest):
    if _collection.count() == 0:
        return {"answer": "No documents ingested yet.", "sources": []}

    chunks = search(req.question, class_name=req.class_name)
    if not chunks:
        return {"answer": "No relevant documents found.", "sources": []}

    context = "\n\n---\n\n".join(
        f"[{c['metadata']['filename']} | {c['metadata'].get('class_name','General')}]\n{c['text']}"
        for c in chunks
    )
    messages = [
        SystemMessage(content=_SYSTEM),
        HumanMessage(content=f"Context:\n{context}\n\nQuestion: {req.question}"),
    ]
    response = _llm.invoke(messages)
    return {"answer": response.content, "sources": [c["metadata"] for c in chunks]}


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    if _collection.count() == 0:
        async def empty():
            yield 'data: {"token": "No documents ingested yet."}\n\n'
            yield 'data: {"done": true, "sources": []}\n\n'
        return StreamingResponse(empty(), media_type="text/event-stream")

    chunks = search(req.question, class_name=req.class_name)
    sources = [c["metadata"] for c in chunks]

    if not chunks:
        async def no_results():
            yield 'data: {"token": "No relevant documents found."}\n\n'
            yield f'data: {{"done": true, "sources": []}}\n\n'
        return StreamingResponse(no_results(), media_type="text/event-stream")

    context = "\n\n---\n\n".join(
        f"[{c['metadata']['filename']} | {c['metadata'].get('class_name','General')}]\n{c['text']}"
        for c in chunks
    )
    messages = [
        SystemMessage(content=_SYSTEM),
        HumanMessage(content=f"Context:\n{context}\n\nQuestion: {req.question}"),
    ]

    import json

    async def token_stream():
        for chunk in _llm.stream(messages):
            if chunk.content:
                yield f"data: {json.dumps({'token': chunk.content})}\n\n"
        yield f"data: {json.dumps({'done': True, 'sources': sources})}\n\n"

    return StreamingResponse(token_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


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
        threshold = 0.3
        for i in range(len(filenames)):
            for j in range(i + 1, len(filenames)):
                a, b = filenames[i], filenames[j]
                sim = float(np.dot(centroids[a], centroids[b]))
                if sim > threshold:
                    edges.append({"source": a, "target": b, "weight": round(sim, 3)})

    classes = list({file_meta[fn]["class_name"] for fn in filenames})
    class_nodes = [{"id": c, "type": "class"} for c in classes]
    file_nodes = [
        {"id": fn, "type": "file", "class_name": file_meta[fn]["class_name"],
         "chunk_count": len(file_chunks[fn])}
        for fn in filenames
    ]
    class_edges = [{"source": fn, "target": file_meta[fn]["class_name"], "weight": 0.5} for fn in filenames]

    return {"nodes": file_nodes + class_nodes, "edges": edges + class_edges}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
