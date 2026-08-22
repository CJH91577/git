"""Embedding 抽象层：本地 fastembed（免 Key）与 OpenAI 兼容 API 均可。"""

from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np

from aegis.config import get_settings

# bge 系列模型的检索侧指令前缀（提升语义检索质量）
_BGE_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："


class EmbeddingProvider(ABC):
    name: str = "base"

    @abstractmethod
    def embed_documents(self, texts: list[str]) -> np.ndarray: ...

    def embed_query(self, text: str) -> np.ndarray:
        return self.embed_documents([text])[0]

    def embed_many(self, texts: list[str], *, batch_size: int = 32) -> np.ndarray:
        out: list[np.ndarray] = []
        for i in range(0, len(texts), batch_size):
            out.append(self.embed_documents(texts[i : i + batch_size]))
        return np.vstack(out)


class FastembedProvider(EmbeddingProvider):
    """本地 ONNX 嵌入，无需 API Key；首次使用自动下载模型。"""

    name = "fastembed"

    def __init__(self, model_name: str | None = None) -> None:
        from fastembed import TextEmbedding

        self.model_name = model_name or get_settings().embed_model
        self._model = TextEmbedding(model_name=self.model_name)

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        return np.array(list(self._model.embed(list(texts))), dtype=np.float32)

    def embed_query(self, text: str) -> np.ndarray:
        return self.embed_documents([_BGE_QUERY_PREFIX + text])[0]


class OpenAICompatEmbeddings(EmbeddingProvider):
    name = "openai"

    def __init__(self, *, api_key: str | None = None, base_url: str | None = None,
                 model: str | None = None) -> None:
        from openai import OpenAI

        s = get_settings()
        self.model = model or s.embed_model or "text-embedding-3-small"
        self._client = OpenAI(
            api_key=api_key or s.embed_api_key or "EMPTY",
            base_url=base_url or s.embed_base_url or None,
            timeout=120,
            max_retries=1,
        )

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        resp = self._client.embeddings.create(model=self.model, input=list(texts))
        data = sorted(resp.data, key=lambda d: d.index)
        return np.array([d.embedding for d in data], dtype=np.float32)


class OllamaEmbeddings(EmbeddingProvider):
    name = "ollama"

    def __init__(self, *, model: str | None = None, base_url: str | None = None) -> None:
        import httpx

        s = get_settings()
        self.model = model or "nomic-embed-text"
        self.base_url = (base_url or s.ollama_base_url).rstrip("/")
        self._client = httpx.Client(timeout=180)

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        rows = []
        for t in texts:
            resp = self._client.post(f"{self.base_url}/api/embed", json={"model": self.model, "input": t})
            resp.raise_for_status()
            rows.append(resp.json()["embeddings"][0])
        return np.array(rows, dtype=np.float32)

    def embed_query(self, text: str) -> np.ndarray:
        return self.embed_documents([_BGE_QUERY_PREFIX + text])[0]


def build_embeddings() -> EmbeddingProvider:
    s = get_settings()
    provider = (s.embed_provider or "fastembed").lower()
    if provider == "fastembed":
        return FastembedProvider()
    if provider == "openai":
        return OpenAICompatEmbeddings()
    if provider == "ollama":
        return OllamaEmbeddings()
    raise ValueError(f"未知 embedding provider: {provider}")
