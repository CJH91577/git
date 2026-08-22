"""Retriever 智能体 —— 执行检索计划：混合检索 + MCP 工具调用。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from aegis.agents.base import BaseAgent, evidence_to_dict
from aegis.mcp import ToolResult
from aegis.retrieval import EvidenceItem, HybridRetriever


@dataclass
class EvidenceBundle:
    evidence: list[EvidenceItem] = field(default_factory=list)
    tool_results: list[ToolResult] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "evidence": evidence_to_dict(self.evidence),
            "tool_results": [r.__dict__ for r in self.tool_results],
        }


class RetrieverAgent(BaseAgent):
    name = "retriever"
    role = "检索者"
    description = "按计划检索知识库证据并执行安全工具调用"

    def __init__(self, llm, *, hybrid: HybridRetriever, mcp_client) -> None:
        super().__init__(llm)
        self.hybrid = hybrid
        self.mcp = mcp_client

    async def retrieve(self, plan, *, top_k: int | None = None) -> EvidenceBundle:
        bundle = EvidenceBundle()

        # 1) 工具调用（planner 规划的计算/时间等工具）
        for call in plan.tools_to_call:
            tool = str(call.get("tool", ""))
            args = dict(call.get("args", {}) or {})
            if tool:
                result = await self.mcp.call_tool(tool, args, agent=self.name)
                bundle.tool_results.append(result)

        # 2) 知识库检索（按子问题，结果按 chunk_id 去重合并）
        if plan.needs_retrieval:
            seen: set[str] = set()
            for q in plan.sub_questions:
                for item in self.hybrid.search(q, top_k=top_k):
                    if item.chunk_id not in seen:
                        seen.add(item.chunk_id)
                        bundle.evidence.append(item)
            bundle.evidence.sort(key=lambda e: e.score, reverse=True)

        return bundle
