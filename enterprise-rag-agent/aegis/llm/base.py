"""LLM 抽象层：统一的 OpenAI 兼容接口，多种后端可插拔。"""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from typing import Any

Message = dict[str, str]


class LLMError(RuntimeError):
    """LLM 调用失败。"""


class LLMProvider(ABC):
    """所有 LLM 后端实现该接口。"""

    name: str = "base"

    @abstractmethod
    def complete(
        self,
        messages: list[Message],
        *,
        json_mode: bool = False,
        temperature: float | None = None,
    ) -> str:
        """返回模型原始文本输出。"""

    def complete_json(
        self,
        messages: list[Message],
        *,
        temperature: float | None = None,
        fallback: Any = None,
    ) -> Any:
        """要求模型输出 JSON 并解析为对象；失败时自动带错误重试一次。"""
        boosted = _ensure_json_instruction(messages)
        raw = self.complete(boosted, json_mode=True, temperature=temperature or 0.0)
        parsed = _parse_json(raw)
        if parsed is not None:
            return parsed
        # 第一次解析失败：把错误反馈给模型，重试一次
        retry = list(messages) + [
            {
                "role": "user",
                "content": (
                    "你上一次的输出不是合法 JSON，无法解析。请只输出一个合法 JSON 对象，"
                    "不要包含任何解释、Markdown 代码块或多余文本。"
                ),
            }
        ]
        raw2 = self.complete(_ensure_json_instruction(retry), json_mode=True, temperature=0.0)
        parsed2 = _parse_json(raw2)
        if parsed2 is not None:
            return parsed2
        if fallback is not None:
            return fallback
        raise LLMError(f"模型两次输出均无法解析为 JSON: {raw2[:200]!r}")


def _parse_json(raw: str) -> Any | None:
    text = raw.strip()
    # 剥离 ```json ... ``` 代码块
    m = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.S)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # 截取首个 { 到最后一个 }
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    return None


def _ensure_json_instruction(messages: list[Message]) -> list[Message]:
    for msg in messages:
        if msg.get("role") == "system" and "JSON" in msg.get("content", "").upper():
            return messages
    return [{"role": "system", "content": "你必须只输出一个合法 JSON 对象，不要输出任何其他内容。"}] + list(messages)
