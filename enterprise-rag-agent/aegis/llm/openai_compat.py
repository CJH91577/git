"""OpenAI 兼容协议 LLM 后端（OpenAI / DeepSeek / Ollama / vLLM / 通义 …）。"""

from __future__ import annotations

from typing import Any

from openai import OpenAI

from aegis.config import get_settings
from aegis.llm.base import LLMError, LLMProvider, Message


class OpenAICompatLLM(LLMProvider):
    name = "openai"

    def __init__(self, *, api_key: str | None = None, base_url: str | None = None,
                 model: str | None = None, temperature: float | None = None,
                 timeout: float | None = None) -> None:
        s = get_settings()
        self.model = model or s.llm_model
        self.temperature = temperature if temperature is not None else s.llm_temperature
        self._client = OpenAI(
            api_key=api_key if api_key is not None else (s.llm_api_key or "EMPTY"),
            base_url=base_url or s.llm_base_url or None,
            timeout=timeout or s.llm_timeout,
            max_retries=1,
        )

    def complete(
        self,
        messages: list[Message],
        *,
        json_mode: bool = False,
        temperature: float | None = None,
    ) -> str:
        kwargs: dict[str, Any] = {"temperature": temperature if temperature is not None else self.temperature}
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = self._client.chat.completions.create(model=self.model, messages=messages, **kwargs)
        except Exception as exc:  # noqa: BLE001 —— 统一转 LLMError
            raise LLMError(f"LLM 调用失败: {exc}") from exc
        content = resp.choices[0].message.content
        return content or ""


class OllamaLLM(OpenAICompatLLM):
    """走 Ollama 的 OpenAI 兼容端点（http://127.0.0.1:11434/v1）。"""

    name = "ollama"

    def __init__(self, *, model: str | None = None, **kwargs: Any) -> None:
        s = get_settings()
        super().__init__(
            api_key="ollama",
            base_url=s.ollama_base_url.rstrip("/") + "/v1",
            model=model or s.llm_model or "qwen2.5:3b",
            **kwargs,
        )


def build_llm() -> LLMProvider:
    """根据配置构建 LLM 后端。"""
    from aegis.llm.scripted import ScriptedLLM

    s = get_settings()
    provider = (s.llm_provider or "scripted").lower()
    if provider in ("openai", "openai-compat", "deepseek"):
        return OpenAICompatLLM()
    if provider == "ollama":
        return OllamaLLM()
    if provider in ("scripted", "mock", "offline"):
        return ScriptedLLM()
    raise LLMError(f"未知 LLM provider: {provider}")
