"""Planner 智能体 —— 理解问题、拆解子问题、制定检索与工具调用计划。"""

from __future__ import annotations

from typing import Any

from aegis.agents.base import BaseAgent, Plan, format_tool_catalog


class PlannerAgent(BaseAgent):
    name = "planner"
    role = "规划者"
    description = "把用户问题拆解为可执行的检索子问题与工具调用计划"

    def build_messages(self, question: str, tool_catalog: list[dict[str, Any]]) -> list[dict[str, str]]:
        return [
            {
                "role": "system",
                "content": (
                    f"你是企业知识库智能体的{self.role}。\n"
                    "[TASK:planner]\n"
                    "你的职责：分析用户问题，输出一个 JSON 计划，字段如下：\n"
                    '{\n'
                    '  "needs_retrieval": true/false,   // 是否需要检索知识库\n'
                    '  "sub_questions": ["子问题1", ...],  // 检索子问题，最多3个\n'
                    '  "tools_to_call": [{"tool": "工具名", "args": {...}}],  // 需要先调用的工具\n'
                    '  "reasoning": "一句话说明规划思路"\n'
                    '}\n'
                    "规则：\n"
                    "1. 涉及企业制度/产品/数据等内部知识的问题必须检索（needs_retrieval=true），拆成具体子问题；\n"
                    "2. 纯数学计算、当前时间等可直接由工具回答的问题，把工具调用写入 tools_to_call；\n"
                    "3. 仅当用户明确要求执行外部动作（发邮件/导出/删除）时，才规划敏感工具；\n"
                    "4. 若问题中包含 [ACTION] 标签（两种形式均可），将该工具调用原样加入 tools_to_call（去重）：\n"
                    "   形式A(JSON):  [ACTION] {\"tool\": \"send_email\", \"args\": {\"to\": \"a@b.com\"}}\n"
                    "   形式B(键值):  [ACTION] send_email to=a@b.com subject=通知 body=内容\n"
                    "5. 只输出 JSON，不要任何解释。\n\n"
                    "当前可用的 MCP 工具目录：\n"
                    f"{format_tool_catalog(tool_catalog)}"
                ),
            },
            {
                "role": "user",
                "content": f"[EVIDENCE:KB]\n<question>{question}</question>",
            },
        ]

    def make_plan(self, question: str, tool_catalog: list[dict[str, Any]]) -> Plan:
        data = self.llm.complete_json(self.build_messages(question, tool_catalog), fallback={})
        try:
            plan = Plan(
                needs_retrieval=bool(data.get("needs_retrieval", True)),
                sub_questions=[str(q) for q in data.get("sub_questions", [])][:3],
                tools_to_call=list(data.get("tools_to_call", []))[:4],
                reasoning=str(data.get("reasoning", "")),
            )
        except Exception:  # noqa: BLE001 —— LLM 输出异常时兜底为单问题检索
            plan = Plan(sub_questions=[question])
        if plan.needs_retrieval and not plan.sub_questions:
            plan.sub_questions = [question]
        return plan
