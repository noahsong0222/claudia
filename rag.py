from pathlib import Path

import chromadb
from langchain_ollama import OllamaEmbeddings, ChatOllama
from langchain_core.messages import HumanMessage, SystemMessage

DB_DIR = Path(__file__).parent / "db"
EMBED_MODEL = "nomic-embed-text"
CHAT_MODEL = "llama3.2"
N_RESULTS = 6

_client = chromadb.PersistentClient(path=str(DB_DIR))
_collection = _client.get_or_create_collection("claudia")
_embeddings = OllamaEmbeddings(model=EMBED_MODEL)
_llm = ChatOllama(model=CHAT_MODEL)

_SYSTEM = (
    "You are Claudia, a personal AI second brain that answers strictly from the "
    "user's own notes.\n\n"
    "RULES:\n"
    "1. Use ONLY the information in the provided context excerpts. Do not use any "
    "outside knowledge, even if you are confident you know the answer.\n"
    "2. If the answer is not contained in the context, reply with exactly: "
    "\"I couldn't find that in your notes.\" Then, if useful, suggest what the user "
    "could upload or ask instead. Do NOT attempt to answer from general knowledge.\n"
    "3. Never invent facts, names, dates, or numbers that are not in the context.\n"
    "4. When you do answer, cite the filename(s) you used at the end, like: "
    "Source: chapter3.pdf.\n"
    "5. If only part of the question is covered, answer that part and clearly say "
    "which part is not in the notes."
)

# Cosine-similarity floor (score = 1 - distance). If the best retrieved chunk
# scores below this, the question is almost certainly not covered by the notes,
# so we refuse before the LLM ever sees weak context and hallucinates from it.
RELEVANCE_FLOOR = 0.25
NOT_FOUND_MSG = "I couldn't find that in your notes."


def _build_where(class_name: str | None, filename: str | None) -> dict | None:
    if filename:
        return {"filename": filename}
    if class_name:
        return {"class_name": class_name}
    return None


def search(
    query: str,
    n: int = N_RESULTS,
    class_name: str | None = None,
    filename: str | None = None,
) -> list[dict]:
    total = _collection.count()
    if total == 0:
        return []
    vector = _embeddings.embed_query(query)
    where = _build_where(class_name, filename)
    results = _collection.query(
        query_embeddings=[vector],
        n_results=min(n, total),
        where=where,
        include=["documents", "metadatas", "distances"],
    )
    return [
        {"text": doc, "metadata": meta, "distance": dist}
        for doc, meta, dist in zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        )
    ]


def get_all_chunks(class_name: str | None = None, filename: str | None = None) -> list[str]:
    """Return all document text chunks for a given scope (for summary/flashcard)."""
    total = _collection.count()
    if total == 0:
        return []
    where = _build_where(class_name, filename)
    result = _collection.get(where=where, include=["documents"])
    return result["documents"]


def ask(question: str, class_name: str | None = None, filename: str | None = None) -> dict:
    chunks = search(question, class_name=class_name, filename=filename)
    if not chunks:
        return {"answer": "No documents have been ingested yet.", "sources": []}

    context = "\n\n---\n\n".join(
        f"[{c['metadata']['filename']} | {c['metadata'].get('class_name', 'General')}]\n{c['text']}"
        for c in chunks
    )
    messages = [
        SystemMessage(content=_SYSTEM),
        HumanMessage(content=f"Context:\n{context}\n\nQuestion: {question}"),
    ]
    response = _llm.invoke(messages)
    return {"answer": response.content, "sources": [c["metadata"] for c in chunks]}


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print('Usage: python rag.py "your question" [class_name]')
        sys.exit(1)
    result = ask(" ".join(sys.argv[1:]))
    print("\nAnswer:\n", result["answer"])
