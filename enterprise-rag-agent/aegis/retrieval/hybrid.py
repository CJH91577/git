"""混合检索：向量语义检索 + BM25 关键词检索 + RRF 融合。

向量检索擅长语义相近但用词不同的问题；
BM25 擅长精确术语/编号/专有名词；
Reciprocal Rank Fusion 取两者之长。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from rank_bm25 import BM25Okapi

from aegis.config import get_settings
from aegis.embeddings import EmbeddingProvider, build_embeddings
from aegis.retrieval.vectorstore import ChromaStore

_RRF_K = 60.0


@dataclass
class EvidenceItem:
    chunk_id: str
    text: str
    doc_id: str
    file_name: str
    location: str
    score: float
    metadata: dict = field(default_factory=dict)

    def describe(self) -> str:
        loc = f" · {self.location}" if self.location else ""
        return f"《{self.file_name}》{loc}"


class HybridRetriever:
    def __init__(
        self,
        *,
        embeddings: EmbeddingProvider | None = None,
        vector_store: ChromaStore | None = None,
    ) -> None:
        s = get_settings()
        self.embeddings = embeddings or build_embeddings()
        self.store = vector_store or ChromaStore(s.chroma_dir)
        self._bm25: BM25Okapi | None = None
        self._bm25_docs: list[dict[str, Any]] = []
        self._bm25_version = -1
        self._lock = threading.Lock()

    # ---------------- BM25 索引（惰性构建/刷新） ----------------

    def _ensure_bm25(self) -> None:
        version = self.store.count()
        if self._bm25 is not None and version == self._bm25_version:
            return
        with self._lock:
            version = self.store.count()
            if self._bm25 is not None and version == self._bm25_version:
                return
            docs = self.store.all_chunks()
            corpus = [self._tokenize(d["text"]) for d in docs]
            self._bm25 = BM25Okapi(corpus) if corpus else None
            self._bm25_docs = docs
            self._bm25_version = version

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        import jieba

        jieba.setLogLevel(60)  # 静默 jieba 启动日志
        return [t for t in jieba.cut(text) if t.strip()]

    # ---------------- 检索 ----------------

    def search(self, query: str, *, top_k: int | None = None) -> list[EvidenceItem]:
        s = get_settings()
        top_k = top_k or s.rerank_top_k
        vec_k = s.retrieval_top_k
        bm25_k = s.bm25_top_k

        # 1) 向量检索
        qv = self.embeddings.embed_query(query)
        vec_hits = self.store.query(qv, top_k=vec_k)

        # 2) BM25 检索
        self._ensure_bm25()
        bm25_hits: list[tuple[dict[str, Any], float]] = []
        if self._bm25 is not None:
            scores = self._bm25.get_scores(self._tokenize(query))
            order = np.argsort(scores)[::-1][:bm25_k]
            for idx in order:
                bm25_hits.append((self._bm25_docs[idx], float(scores[idx])))

        # 3) RRF 融合
        rrf: dict[str, float] = {}
        source_map: dict[str, dict[str, Any]] = {}
        for rank, hit in enumerate(vec_hits):
            rrf[hit["chunk_id"]] = rrf.get(hit["chunk_id"], 0.0) + 1.0 / (_RRF_K + rank + 1)
            source_map[hit["chunk_id"]] = hit
        for rank, (hit, _score) in enumerate(bm25_hits):
            rrf[hit["chunk_id"]] = rrf.get(hit["chunk_id"], 0.0) + 1.0 / (_RRF_K + rank + 1)
            source_map.setdefault(
                hit["chunk_id"],
                {**hit, "vector_score": 0.0},
            )

        ranked = sorted(rrf.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
        evidence: list[EvidenceItem] = []
        for chunk_id, score in ranked:
            hit = source_map[chunk_id]
            meta = hit.get("metadata") or {}
            evidence.append(
                EvidenceItem(
                    chunk_id=chunk_id,
                    text=hit["text"],
                    doc_id=meta.get("doc_id", ""),
                    file_name=meta.get("source", "unknown"),
                    location=self._location(meta),
                    score=round(score, 4),
                    metadata=meta,
                )
            )
        return evidence

    def stats(self) -> dict[str, Any]:
        return {"total_chunks": self.store.count()}

    @staticmethod
    def _location(meta: dict) -> str:
        parts = []
        if meta.get("page"):
            parts.append(f"第{meta['page']}页")
        if meta.get("sheet"):
            parts.append(f"工作表《{meta['sheet']}》")
        if meta.get("slide"):
            parts.append(f"第{meta['slide']}页幻灯片")
        return " ".join(parts)
