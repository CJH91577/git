"""Answerer 智能体 —— 基于证据生成带引用的答案草稿。"""

from __future__ import annotations

from aegis.agents.base import BaseAgent, format_evidence
from aegis.retrieval import EvidenceItem

_NO_EVIDENCE_REPLY = (
    "抱歉，知识库中没有找到与您问题相关的依据，我无法给出可靠回答。"
    "建议补充相关文档，或换个角度描述问题。"
)


class AnswererAgent(BaseAgent):
    name = "answerer"
    role = "回答者"
    description = "基于检索证据生成带引用、不编造的答案"

    def build_messages(
        self,
        question: str,
        evidence: list[EvidenceItem],
        tool_results_text: str = "",
        feedback: str = "",
    ) -> list[dict[str, str]]:
        return [
            {
                "role": "system",
                "content": (
                    f"你是企业知识库智能体的{self.role}。\n"
                    "[TASK:answer]\n"
                    "基于下方【证据】回答用户问题，规则：\n"
                    "1. 答案中的每个事实性陈述必须来自证据，并在句末标注引用编号 [C1][C2]；\n"
                    "2. 证据不包含的信息，明确说「知识库中没有相关依据」，严禁编造；\n"
                    "3. 证据互相矛盾时，指出矛盾并说明不同来源；\n"
                    "4. 语言简洁、结构化（可用列表），直接回答，不要复述证据原文。\n"
                    + (f"5. 审计反馈（必须据此修正）：{feedback}\n" if feedback else "")
                ),
            },
            {
                "role": "user",
                "content": (
                    f"<question>{question}</question>\n\n"
                    "【工具调用结果】\n"
                    f"{tool_results_text or '（无）'}\n\n"
                    "【证据】\n"
                    f"{format_evidence(evidence)}"
                ),
            },
        ]

    def answer(
        self,
        question: str,
        evidence: list[EvidenceItem],
        *,
        tool_results_text: str = "",
        feedback: str = "",
    ) -> str:
        if not evidence and not tool_results_text:
            return _NO_EVIDENCE_REPLY
        return self.llm.complete(
            self.build_messages(question, evidence, tool_results_text, feedback),
            temperature=0.3,
        )
