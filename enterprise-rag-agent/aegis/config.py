"""全局配置（环境变量 / .env 驱动，前缀 AEGIS_）。"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="AEGIS_", env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # ---------- LLM ----------
    llm_provider: str = "openai"  # openai | ollama | scripted
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_model: str = "gpt-4o-mini"
    llm_temperature: float = 0.2
    llm_timeout: float = 180.0
    ollama_base_url: str = "http://127.0.0.1:11434"

    # ---------- Embeddings ----------
    embed_provider: str = "fastembed"  # fastembed | openai | ollama
    embed_model: str = "BAAI/bge-small-zh-v1.5"
    embed_api_key: str = ""
    embed_base_url: str = ""

    # ---------- 存储 ----------
    data_dir: Path = Path("./data")
    chroma_dir: Path = Path("./data/chroma")
    upload_dir: Path = Path("./data/uploads")

    # ---------- 切块 ----------
    chunk_size: int = 600
    chunk_overlap: int = 80
    min_chunk_chars: int = 30

    # ---------- 检索 ----------
    retrieval_top_k: int = 6
    bm25_top_k: int = 6
    rerank_top_k: int = 4

    # ---------- 智能体 ----------
    max_audit_rounds: int = 3
    auditor_score_threshold: float = 0.7

    # ---------- HITL ----------
    hitl_enabled: bool = True
    hitl_mode: str = "interactive"  # interactive | auto_approve | auto_deny

    # ---------- MCP ----------
    mcp_transport: str = "inprocess"  # inprocess | stdio
    max_tool_rounds: int = 4

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.chroma_dir, self.upload_dir):
            Path(d).mkdir(parents=True, exist_ok=True)

    def resolve(self, p: Path) -> Path:
        """把相对路径解析为绝对路径（锚定 data_dir 的父级，避免 cwd 漂移）。"""
        p = Path(p)
        return p if p.is_absolute() else Path.cwd() / p


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def reset_settings() -> None:
    global _settings
    _settings = None
