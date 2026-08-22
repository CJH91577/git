"""Auditor 智能体 —— 事实核查与自我修正：逐条核对答案中的声明是否有证据支撑。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from aegis.agents.base import BaseAgent, format_evidence
from aegis.retrieval import EvidenceItem


@dataclass
class AuditReport:
    verdict: str  # pass | revise
    score: float  # 0~1
    feedback: str
    claims: list[dict[str, Any]]
    missing_topics: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.missing_topics is None:
            self.missing_topics = []

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "score": self.score,
            "feedback": self.feedback,
            "claims": self.claims,
            "missing_topics": self.missing_topics,
        }


class AuditorAgent(BaseAgent):
    name = "auditor"
    role = "审核者"
    description = "对答案草稿做事实核查，输出通过/修订意见，必要时补充检索"

    def build_messages(
        self,
        question: str,
        draft: str,
        evidence: list[EvidenceItem],
        mcp_available: bool = True,
        tool_results_text: str = "",
    ) -> list[dict[str, str]]:
        return [
            {
                "role": "system",
                "content": (
                    f"你是企业知识库智能体的{self.role}（事实核查员）。\n"
                    "[TASK:audit]\n"
                    "逐条核查【答案草稿】中的事实性声明是否被【证据】支撑，输出 JSON：\n"
                    '{\n'
                    '  "verdict": "pass" | "revise",   // 全部声明有据且无遗漏 → pass\n'
                    '  "score": 0.0~1.0,                // 事实可信度评分\n'
                    '  "claims": [{"claim": "声明原文", "support": "supported|unsupported|contradicted", '
                    '"citations": ["C1"], "issue": "问题说明或空"}],\n'
                    '  "feedback": "对回答者的具体修订意见",\n'
                    '  "missing_topics": ["证据缺失但问题要求覆盖的主题"]\n'
                    '}\n'
                    "核查标准：\n"
                    "1. 答案中出现证据没有的数字/名称/规则 → unsupported（编造风险）；\n"
                    "2. 引用了不存在的编号 → 扣分；\n"
                    "3. 用户问题要求的关键信息证据缺失 → missing_topics 列出，verdict=revise；\n"
                    "4. 只有全部声明被充分支撑且关键信息齐备才允许 pass；\n"
                    "5. 只输出 JSON。"
                    + ("\n\n如证据不足，你可在下一步通过 kb_search 工具补充检索后重新核查。" if mcp_available else "")
                ),
            },
            {
                "role": "user",
                "content": (
                    f"<question>{question}</question>\n\n"
                    f"【答案草稿】\n<draft>{draft}</draft>\n\n"
                    f"【工具调用结果】\n{tool_results_text or '（无）'}\n\n"
                    f"【证据】\n{format_evidence(evidence)}"
                ),
            },
        ]

    def audit(
        self,
        question: str,
        draft: str,
        evidence: list[EvidenceItem],
        *,
        tool_results_text: str = "",
    ) -> AuditReport:
        data = self.llm.complete_json(
            self.build_messages(question, draft, evidence, tool_results_text=tool_results_text),
            fallback={"verdict": "pass", "score": 0.8, "claims": [], "feedback": "", "missing_topics": []},
        )
        verdict = str(data.get("verdict", "pass")).lower()
        if verdict not in ("pass", "revise"):
            verdict = "revise"
        try:
            score = float(data.get("score", 0.0))
        except (TypeError, ValueError):
            score = 0.0
        return AuditReport(
            verdict=verdict,
            score=max(0.0, min(1.0, score)),
            feedback=str(data.get("feedback", "")),
            claims=[dict(c) for c in data.get("claims", [])][:10],
            missing_topics=[str(t) for t in data.get("missing_topics", [])][:5],
        )
