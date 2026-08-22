"""Chroma 向量库封装：持久化存储、按文档增删、向量检索。"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np

from aegis.embeddings import EmbeddingProvider
from aegis.ingestion.chunker import Chunk

_COLLECTION = "knowledge_base"


class ChromaStore:
    def __init__(self, persist_dir: str | Path) -> None:
        import chromadb

        self.persist_dir = Path(persist_dir)
        self.persist_dir.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(path=str(self.persist_dir))
        self._lock = threading.Lock()
        self.collection = self._client.get_or_create_collection(
            name=_COLLECTION, metadata={"hnsw:space": "cosine"}
        )

    # ---------------- 写入 ----------------

    def add_chunks(self, doc_id: str, chunks: list[Chunk], embeddings: EmbeddingProvider) -> None:
        if not chunks:
            return
        texts = [c.text for c in chunks]
        vectors = embeddings.embed_many(texts)
        ids = [f"{doc_id}::{i}" for i in range(len(chunks))]
        metas = [
            {
                "doc_id": doc_id,
                "chunk_index": str(c.metadata.get("chunk_index", i)),
                **{k: str(v) for k, v in c.metadata.items()},
            }
            for i, c in enumerate(chunks)
        ]
        with self._lock:
            self.collection.upsert(ids=ids, documents=texts, embeddings=vectors.tolist(), metadatas=metas)

    def delete_by_doc(self, doc_id: str) -> None:
        with self._lock:
            try:
                self.collection.delete(where={"doc_id": doc_id})
            except Exception:  # noqa: BLE001 —— chroma 空 where 删除兼容
                pass

    # ---------------- 读取 ----------------

    def query(self, query_embedding: np.ndarray, *, top_k: int = 6, where: dict | None = None) -> list[dict[str, Any]]:
        if self.count() == 0:
            return []
        res = self.collection.query(
            query_embeddings=[query_embedding.tolist()],
            n_results=min(top_k, self.count()),
            where=where or None,
            include=["documents", "metadatas", "distances"],
        )
        hits: list[dict[str, Any]] = []
        for i, doc in enumerate(res["documents"][0]):
            meta = (res["metadatas"][0] or [{}])[i] or {}
            dist = (res["distances"][0] or [1.0])[i]
            hits.append(
                {
                    "chunk_id": res["ids"][0][i],
                    "text": doc,
                    "metadata": meta,
                    "vector_score": float(1.0 - dist / 2.0),  # cosine → [0,1] 相似度
                }
            )
        return hits

    def all_chunks(self) -> list[dict[str, Any]]:
        if self.count() == 0:
            return []
        res = self.collection.get(include=["documents", "metadatas"])
        return [
            {"chunk_id": cid, "text": doc, "metadata": meta or {}}
            for cid, doc, meta in zip(res["ids"], res["documents"], res["metadatas"])
        ]

    def count(self) -> int:
        try:
            return self.collection.count()
        except Exception:  # noqa: BLE001
            return 0
