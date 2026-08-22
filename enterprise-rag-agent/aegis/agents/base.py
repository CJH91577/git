"""智能体基类与公共提示词工具。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from aegis.llm import LLMProvider
from aegis.retrieval import EvidenceItem


@dataclass
class AgentResult:
    ok: bool
    data: Any = None
    error: str = ""


@dataclass
class Plan:
    needs_retrieval: bool = True
    sub_questions: list[str] = field(default_factory=list)
    tools_to_call: list[dict[str, Any]] = field(default_factory=list)
    reasoning: str = ""


class BaseAgent:
    name: str = "base"
    role: str = ""
    description: str = ""

    def __init__(self, llm: LLMProvider) -> None:
        self.llm = llm


def format_evidence(evidence: list[EvidenceItem], *, max_items: int = 8) -> str:
    """把证据列表格式化为带编号的引用块。"""
    if not evidence:
        return "（无可用证据）"
    lines = []
    for i, item in enumerate(evidence[:max_items], 1):
        lines.append(f"[C{i}] 来源: {item.describe()}\n{item.text}")
    return "\n\n".join(lines)


def format_tool_catalog(catalog: list[dict[str, Any]]) -> str:
    """工具目录 → 文本描述（供 Planner 决策）。"""
    if not catalog:
        return "（当前无可用工具）"
    lines = []
    for t in catalog:
        lines.append(
            f"- {t['name']}: {t['description']}\n  参数 schema: {t['input_schema']}"
        )
    return "\n".join(lines)


def evidence_to_dict(items: list[EvidenceItem]) -> list[dict[str, Any]]:
    return [
        {
            "chunk_id": e.chunk_id,
            "text": e.text,
            "doc_id": e.doc_id,
            "file_name": e.file_name,
            "location": e.location,
            "score": e.score,
        }
        for e in items
    ]


def evidence_from_dict(items: list[dict[str, Any]]) -> list[EvidenceItem]:
    return [
        EvidenceItem(
            chunk_id=d["chunk_id"],
            text=d["text"],
            doc_id=d.get("doc_id", ""),
            file_name=d.get("file_name", ""),
            location=d.get("location", ""),
            score=float(d.get("score", 0.0)),
        )
        for d in items
    ]
