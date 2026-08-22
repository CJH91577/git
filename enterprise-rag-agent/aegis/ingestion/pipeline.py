"""入库管道：解析 → 切块 → 嵌入 → 写入向量库 + 文档登记。

以文件 SHA-256 去重：重复入库自动覆盖旧版本。
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aegis.config import get_settings
from aegis.embeddings import EmbeddingProvider, build_embeddings
from aegis.ingestion.chunker import chunk_segment
from aegis.ingestion.parsers import RawSegment, parse_file


@dataclass
class DocRecord:
    doc_id: str
    file_name: str
    file_size: int
    sha256: str
    chunk_count: int
    ingested_at: str
    segments: list[RawSegment] = field(default_factory=list, repr=False)


class DocRegistry:
    """文档登记表（JSON 持久化），记录入库历史。"""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def load(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}

    def save(self, data: dict[str, dict[str, Any]]) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def register(self, rec: DocRecord) -> None:
        data = self.load()
        data[rec.doc_id] = {
            "doc_id": rec.doc_id,
            "file_name": rec.file_name,
            "file_size": rec.file_size,
            "sha256": rec.sha256,
            "chunk_count": rec.chunk_count,
            "ingested_at": rec.ingested_at,
        }
        self.save(data)

    def remove(self, doc_id: str) -> None:
        data = self.load()
        data.pop(doc_id, None)
        self.save(data)

    def list(self) -> list[dict[str, Any]]:
        return sorted(self.load().values(), key=lambda d: d["ingested_at"], reverse=True)


class IngestionPipeline:
    """端到端入库管道。"""

    def __init__(
        self,
        *,
        embeddings: EmbeddingProvider | None = None,
        vector_store: Any | None = None,
        data_dir: Path | None = None,
    ) -> None:
        s = get_settings()
        self.data_dir = Path(data_dir) if data_dir else s.data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.embeddings = embeddings or build_embeddings()
        self.registry = DocRegistry(self.data_dir / "doc_registry.json")
        if vector_store is not None:
            self.store = vector_store
        else:
            from aegis.retrieval.vectorstore import ChromaStore

            self.store = ChromaStore(s.chroma_dir)

    # ---------------- 核心流程 ----------------

    def ingest_file(self, path: str | Path) -> DocRecord:
        s = get_settings()
        path = Path(path)
        sha = _sha256(path)
        doc_id = f"doc_{sha[:16]}"

        # 已有旧版本 → 先清理
        old = self.registry.load().get(doc_id)
        if old:
            self.delete_document(doc_id)

        segments = parse_file(path)
        chunks = []
        for seg in segments:
            chunks.extend(chunk_segment(seg, s.chunk_size, s.chunk_overlap))
        if not chunks:
            raise ValueError(f"{path.name}: 切块后无有效内容")

        # 写入向量库
        self.store.add_chunks(
            doc_id=doc_id,
            chunks=chunks,
            embeddings=self.embeddings,
        )

        rec = DocRecord(
            doc_id=doc_id,
            file_name=path.name,
            file_size=path.stat().st_size,
            sha256=sha,
            chunk_count=len(chunks),
            ingested_at=datetime.now(timezone.utc).isoformat(),
            segments=segments,
        )
        self.registry.register(rec)
        return rec

    def ingest_directory(self, directory: str | Path, *, recursive: bool = False) -> list[DocRecord]:
        from aegis.ingestion.parsers import SUPPORTED_EXTS

        directory = Path(directory)
        if not directory.is_dir():
            raise ValueError(f"目录不存在: {directory}")
        files = sorted(
            p
            for p in directory.iterdir()
            if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS
        )
        if recursive:
            files = sorted(
                p
                for p in directory.rglob("*")
                if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS
            )
        records, errors = [], []
        for f in files:
            try:
                records.append(self.ingest_file(f))
            except Exception as exc:  # noqa: BLE001 —— 单文件失败不阻断批量
                errors.append(f"{f.name}: {exc}")
        if errors:
            raise RuntimeError("部分文件入库失败:\n" + "\n".join(errors))
        return records

    # ---------------- 管理 ----------------

    def delete_document(self, doc_id: str) -> None:
        self.store.delete_by_doc(doc_id)
        self.registry.remove(doc_id)

    def list_documents(self) -> list[dict[str, Any]]:
        return self.registry.list()

    def stats(self) -> dict[str, Any]:
        docs = self.list_documents()
        return {
            "documents": len(docs),
            "chunks": sum(d["chunk_count"] for d in docs),
            "files": [d["file_name"] for d in docs],
        }


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()
