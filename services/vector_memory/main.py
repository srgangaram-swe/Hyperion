"""
Hyperion Vector Memory Service

FastAPI microservice that wraps sentence-transformers + ChromaDB to give
Hyperion semantic (vector) search on top of its existing JSON memory store.

The Deno server proxies /api/memory?q=... here when VECTOR_MEMORY_URL is set;
it falls back to keyword search otherwise, so this service is fully optional.

Run:
    uvicorn main:app --port 8788 --reload
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

import chromadb
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

logging.basicConfig(level=logging.INFO, format="[VECTOR] %(message)s")
log = logging.getLogger(__name__)

# ── Config ───────────────────────────────────────────────────────────────────

MODEL_NAME = os.getenv("EMBED_MODEL", "all-MiniLM-L6-v2")
CHROMA_PATH = Path(os.getenv("CHROMA_PATH", "./data/chroma"))
PORT = int(os.getenv("VECTOR_PORT", "8788"))

# ── Init ─────────────────────────────────────────────────────────────────────

log.info(f"Loading embedding model: {MODEL_NAME}")
model = SentenceTransformer(MODEL_NAME)

CHROMA_PATH.mkdir(parents=True, exist_ok=True)
chroma = chromadb.PersistentClient(path=str(CHROMA_PATH))
collection = chroma.get_or_create_collection(
    name="hyperion_memory",
    metadata={"hnsw:space": "cosine"},
)
log.info(f"ChromaDB ready — {collection.count()} entries")

app = FastAPI(title="Hyperion Vector Memory", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Schemas ───────────────────────────────────────────────────────────────────

class EmbedRequest(BaseModel):
    id: Optional[str] = None        # use existing ID from JSON store when syncing
    category: str = "fact"
    text: str
    tags: list[str] = []
    agent_id: Optional[str] = None

class EmbedResponse(BaseModel):
    id: str

class SearchHit(BaseModel):
    id: str
    text: str
    category: str
    tags: list[str]
    agent_id: Optional[str]
    score: float

class SearchResponse(BaseModel):
    results: list[SearchHit]

class HealthResponse(BaseModel):
    ok: bool
    model: str
    count: int

# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
def health():
    return {"ok": True, "model": MODEL_NAME, "count": collection.count()}


@app.post("/embed", response_model=EmbedResponse, status_code=201)
def embed(req: EmbedRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    entry_id = req.id or str(uuid.uuid4())
    embedding = model.encode(req.text).tolist()

    collection.upsert(
        ids=[entry_id],
        embeddings=[embedding],
        documents=[req.text],
        metadatas=[{
            "category": req.category,
            "tags": json.dumps(req.tags),
            "agent_id": req.agent_id or "",
        }],
    )
    log.info(f"Embedded [{req.category}] {entry_id[:8]}… — {req.text[:60]!r}")
    return {"id": entry_id}


@app.get("/search", response_model=SearchResponse)
def search(
    q: str = Query(..., description="Search query"),
    limit: int = Query(10, ge=1, le=100),
    category: Optional[str] = Query(None),
):
    count = collection.count()
    if count == 0:
        return {"results": []}

    n = min(limit, count)
    embedding = model.encode(q).tolist()

    where = {"category": category} if category else None
    results = collection.query(
        query_embeddings=[embedding],
        n_results=n,
        where=where,
        include=["documents", "metadatas", "distances"],
    )

    hits: list[SearchHit] = []
    for i, doc_id in enumerate(results["ids"][0]):
        meta = results["metadatas"][0][i]
        distance = results["distances"][0][i]
        hits.append(SearchHit(
            id=doc_id,
            text=results["documents"][0][i],
            category=meta.get("category", "fact"),
            tags=json.loads(meta.get("tags", "[]")),
            agent_id=meta.get("agent_id") or None,
            score=round(1.0 - float(distance), 4),
        ))

    return {"results": hits}


@app.delete("/embed/{entry_id}")
def delete_entry(entry_id: str):
    try:
        collection.delete(ids=[entry_id])
    except Exception:
        raise HTTPException(status_code=404, detail="Not found")
    log.info(f"Deleted {entry_id[:8]}…")
    return {"ok": True}


@app.post("/sync")
def sync_from_json(entries: list[EmbedRequest]):
    """Bulk-import from the Deno JSON memory store (called on startup)."""
    if not entries:
        return {"synced": 0}

    ids = [e.id or str(uuid.uuid4()) for e in entries]
    embeddings = model.encode([e.text for e in entries]).tolist()
    documents = [e.text for e in entries]
    metadatas = [
        {"category": e.category, "tags": json.dumps(e.tags), "agent_id": e.agent_id or ""}
        for e in entries
    ]

    collection.upsert(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)
    log.info(f"Synced {len(ids)} entries from JSON store")
    return {"synced": len(ids)}
