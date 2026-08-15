"""Style Studio — analyze the user's writing and replicate their voice.

Deliberately separate from the notes RAG pipeline. Writing samples and the
derived style profile live in their own JSON store under style/, so class
material never pollutes the user's personal voice.

Two halves:
  1. Deterministic metrics computed in Python (sentence length, vocabulary
     diversity, punctuation habits) — fast, objective, no LLM.
  2. A qualitative style profile + generation, both via the local LLM, which
     reads the samples and either describes the voice or writes in it.
"""

import re
import json
import uuid
from datetime import datetime
from pathlib import Path

STYLE_DIR = Path(__file__).parent / "style"
STYLE_DIR.mkdir(exist_ok=True)
SAMPLES_FILE = STYLE_DIR / "samples.json"
PROFILE_FILE = STYLE_DIR / "profile.json"


# ── sample store ────────────────────────────────────────────────────────────

def _load(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def list_samples() -> list[dict]:
    return _load(SAMPLES_FILE, [])


def add_sample(title: str, text: str) -> dict:
    text = text.strip()
    if not text:
        raise ValueError("Sample text is empty.")
    samples = list_samples()
    sample = {
        "id":       uuid.uuid4().hex[:12],
        "title":    title.strip() or f"sample-{len(samples) + 1}",
        "text":     text,
        "words":    len(text.split()),
        "added_at": datetime.now().isoformat(timespec="seconds"),
    }
    samples.append(sample)
    SAMPLES_FILE.write_text(json.dumps(samples, indent=2))
    return sample


def delete_sample(sample_id: str) -> bool:
    samples = list_samples()
    new = [s for s in samples if s["id"] != sample_id]
    if len(new) == len(samples):
        return False
    SAMPLES_FILE.write_text(json.dumps(new, indent=2))
    return True


# ── deterministic metrics ───────────────────────────────────────────────────

_STOP = {
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
    "with", "is", "are", "was", "were", "be", "been", "it", "this", "that",
    "i", "you", "he", "she", "they", "we", "as", "by", "from", "my", "me",
}


def compute_metrics(samples: list[dict] | None = None) -> dict:
    samples = samples if samples is not None else list_samples()
    text = "\n\n".join(s["text"] for s in samples).strip()
    if not text:
        return {"empty": True}

    words = re.findall(r"[A-Za-z']+", text)
    sentences = [s for s in re.split(r"[.!?]+", text) if s.strip()]
    paragraphs = [p for p in text.split("\n\n") if p.strip()]
    n_words = len(words) or 1
    n_sents = len(sentences) or 1

    lower = [w.lower() for w in words]
    unique = set(lower)

    def per100(ch: str) -> float:
        return round(text.count(ch) / n_words * 100, 2)

    # most-used distinctive words (skip common stop words)
    freq: dict[str, int] = {}
    for w in lower:
        if w not in _STOP and len(w) > 2:
            freq[w] = freq.get(w, 0) + 1
    top_words = sorted(freq.items(), key=lambda kv: kv[1], reverse=True)[:12]

    return {
        "empty":               False,
        "samples":             len(samples),
        "total_words":         n_words,
        "total_sentences":     n_sents,
        "avg_sentence_length": round(n_words / n_sents, 1),
        "avg_word_length":     round(sum(len(w) for w in words) / n_words, 2),
        "vocabulary_richness": round(len(unique) / n_words, 3),  # type-token ratio
        "avg_paragraph_sents": round(n_sents / max(len(paragraphs), 1), 1),
        "punctuation_per_100": {
            "comma":       per100(","),
            "semicolon":   per100(";"),
            "dash":        per100("—") + per100("-"),
            "exclamation": per100("!"),
            "question":    per100("?"),
        },
        "top_words":           [{"word": w, "count": c} for w, c in top_words],
    }


# ── model selection ─────────────────────────────────────────────────────────
# Voice mimicry is the one task where model size matters most: small models
# regress to generic AI prose no matter how good the prompt is. Prefer the
# largest suitable model installed in Ollama; fall back to llama3.2.

_STYLE_MODEL_PREFERENCE = ["qwen2.5:14b", "llama3.1:8b", "llama3.1", "llama3.2"]
_style_llm = None
_style_model_name: str | None = None


def pick_style_model() -> str:
    global _style_model_name
    if _style_model_name:
        return _style_model_name
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:11434/api/tags", timeout=3) as r:
            installed = {m["name"] for m in json.load(r)["models"]}
        # names may or may not carry ":latest"
        norm = {n.removesuffix(":latest") for n in installed} | installed
        for want in _STYLE_MODEL_PREFERENCE:
            if want in norm or f"{want}:latest" in norm:
                _style_model_name = want
                return want
    except Exception:
        pass
    _style_model_name = "llama3.2"
    return _style_model_name


def get_style_llm():
    """LLM used for style analysis + generation. Slightly warm temperature —
    voice replication needs natural variation, not deterministic flatness."""
    global _style_llm
    if _style_llm is None:
        from langchain_ollama import ChatOllama
        model = pick_style_model()
        print(f"Style Studio using model: {model}")
        _style_llm = ChatOllama(model=model, temperature=0.8)
    return _style_llm


# ── LLM profile + generation ────────────────────────────────────────────────

def _samples_blob(max_chars: int = 6000) -> str:
    parts, total = [], 0
    for s in list_samples():
        chunk = f"--- {s['title']} ---\n{s['text']}"
        if total + len(chunk) > max_chars:
            chunk = chunk[: max_chars - total]
        parts.append(chunk)
        total += len(chunk)
        if total >= max_chars:
            break
    return "\n\n".join(parts)


def build_profile(llm) -> dict:
    """Ask the LLM to read all samples and describe the voice. Saves + returns."""
    from langchain_core.messages import HumanMessage, SystemMessage

    samples = list_samples()
    if not samples:
        raise ValueError("Add at least one writing sample first.")

    metrics = compute_metrics(samples)
    blob = _samples_blob()

    prompt = (
        "Below are writing samples from one author. Analyze their voice so it can "
        "be replicated. Be specific and concrete, quoting short phrases where useful.\n\n"
        f"SAMPLES:\n{blob}\n\n"
        "Return ONLY a JSON object with these keys:\n"
        '{\n'
        '  "voice_summary": "2-3 sentence description of how this person writes",\n'
        '  "tone": "e.g. dry and direct, warm and discursive",\n'
        '  "sentence_style": "rhythm, length variation, how they open/close sentences",\n'
        '  "vocabulary": "register, favorite words, jargon, simple vs fancy",\n'
        '  "punctuation": "habits with commas, dashes, semicolons, fragments",\n'
        '  "structure": "how they organize paragraphs and arguments",\n'
        '  "signature_moves": ["distinctive habit 1", "habit 2", "habit 3"],\n'
        '  "avoid": ["things this author never does"]\n'
        '}\n'
        "Reply with the JSON only, no preamble."
    )
    messages = [
        SystemMessage(content="You are a literary analyst specializing in authorial voice. Output only valid JSON."),
        HumanMessage(content=prompt),
    ]
    resp = llm.invoke(messages)
    text = resp.content.strip()
    start, end = text.find("{"), text.rfind("}") + 1
    try:
        profile = json.loads(text[start:end])
    except Exception:
        profile = {"voice_summary": text[:500], "raw": True}

    profile["metrics"] = metrics
    profile["generated_at"] = datetime.now().isoformat(timespec="seconds")
    profile["sample_count"] = len(samples)
    PROFILE_FILE.write_text(json.dumps(profile, indent=2))
    return profile


def get_profile() -> dict | None:
    return _load(PROFILE_FILE, None)


def build_generation_messages(task: str, mode: str = "write"):
    """Construct the system+user messages that make the LLM write as the user."""
    from langchain_core.messages import HumanMessage, SystemMessage

    profile = get_profile() or {}
    samples = list_samples()

    # Feed the FULL corpus (budgeted) — with a small personal corpus, every
    # sentence of real writing is worth more than any description of it.
    budget = 12000
    parts, used = [], 0
    for s in samples:
        text = s["text"][: max(0, budget - used)]
        if not text:
            break
        parts.append(f'--- Sample: "{s["title"]}" ---\n{text}')
        used += len(text)
    corpus = "\n\n".join(parts)

    profile_desc = ""
    for k in ("voice_summary", "tone", "sentence_style", "vocabulary", "punctuation", "structure"):
        if profile.get(k):
            profile_desc += f"- {k.replace('_', ' ').title()}: {profile[k]}\n"
    if profile.get("signature_moves"):
        profile_desc += "- Signature moves: " + "; ".join(profile["signature_moves"]) + "\n"
    if profile.get("avoid"):
        profile_desc += "- Never do: " + "; ".join(profile["avoid"]) + "\n"

    system = (
        "You are ghostwriting for one specific person. Your ONLY job is to be "
        "indistinguishable from them. Their real writing is below — it outranks "
        "every instinct you have about 'good writing'.\n\n"
        f"THEIR ACTUAL WRITING:\n{corpus}\n\n"
        f"STYLE NOTES:\n{profile_desc or '(infer everything from the samples)'}\n\n"
        "HARD RULES:\n"
        "1. Imitate the samples' sentence rhythm: match how long their sentences "
        "run, where they break, how they open and close.\n"
        "2. Use only vocabulary this person would use. If a word doesn't appear "
        "in or near the register of the samples, don't use it.\n"
        "3. NO generic AI prose: no 'delve', 'crucial', 'furthermore', 'in "
        "conclusion', 'it's important to note', no bullet-point essays, no "
        "balanced-on-the-one-hand hedging — unless the samples themselves do it.\n"
        "4. Keep their imperfections. If they write fragments, write fragments. "
        "If they ramble, ramble. Polish is a tell.\n"
        "5. Output ONLY the writing itself. No preamble, no explanation, no title "
        "unless asked."
    )

    if mode == "rewrite":
        user = (
            "Rewrite this so it reads exactly like the samples — same meaning, "
            f"their voice:\n\n{task}"
        )
    else:  # write
        user = f"Write this in their voice:\n\n{task}"

    return [SystemMessage(content=system), HumanMessage(content=user)]
