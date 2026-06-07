import tempfile
import shutil
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from ingest import ingest_file, get_classes, get_files, _collection
from rag import ask

app = FastAPI(title="Claudia API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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


class ChatRequest(BaseModel):
    question: str
    class_name: str | None = None


@app.post("/chat")
def chat(req: ChatRequest):
    if _collection.count() == 0:
        return {"answer": "No documents ingested yet.", "sources": []}
    result = ask(req.question, class_name=req.class_name)
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
