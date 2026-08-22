"""MCP 工具安全策略：按智能体白名单 + 敏感操作审批，实现安全隔离。

三层防线：
1. 工具白名单 —— 每个智能体只能调用其职责范围内的工具（最小权限）；
2. 参数校验 —— 由 MCP 协议的 JSON Schema 强校验（非法参数直接拒绝）；
3. 敏感操作 HITL —— send_email / export_file / delete_document 等
   对外产生影响的工具必须先获得人工审批（ApprovalManager）。
"""

from __future__ import annotations

from dataclasses import dataclass

from aegis.mcp.server import SENSITIVE_TOOLS

# 各智能体允许调用的工具（最小权限原则）。
# 注意：即便在允许名单内，SENSITIVE_TOOLS 仍必须先通过人工审批才能执行
# （白名单=能否接触该工具，敏感标记=执行前是否需要人批准，两道独立防线）。
AGENT_TOOL_ALLOWLIST: dict[str, set[str]] = {
    "planner": set(),  # 规划者只做计划，不直接调工具
    "retriever": {
        "calculator", "get_current_time", "kb_search", "doc_stats",
        "send_email", "export_file", "delete_document",  # 敏感工具：可请求执行，但必须 HITL 审批
    },
    "answerer": set(),
    "auditor": {"kb_search", "doc_stats"},  # 审核者可复核检索
}

# 通配：所有工具（用于维护类操作）
ALL_TOOLS = "*"


@dataclass
class PolicyDecision:
    allowed: bool
    requires_approval: bool = False
    reason: str = ""

    @property
    def ok(self) -> bool:
        return self.allowed


class ToolSecurityPolicy:
    """MCP 工具调用的安全检查器。"""

    def __init__(self, *, allowlists: dict[str, set[str]] | None = None) -> None:
        self.allowlists = allowlists or AGENT_TOOL_ALLOWLIST

    def check(self, tool_name: str, agent: str) -> PolicyDecision:
        # 1) 工具是否存在（由 MCP 层保证，这里做二次防线）
        # 2) 白名单
        allowed_tools = self.allowlists.get(agent)
        if allowed_tools is None:
            return PolicyDecision(False, reason=f"未知智能体角色: {agent}")
        if tool_name not in allowed_tools:
            return PolicyDecision(
                False,
                reason=f"安全策略拒绝：智能体「{agent}」无权调用工具「{tool_name}」（超出最小权限白名单）",
            )
        # 3) 敏感工具 → 需人工审批
        if tool_name in SENSITIVE_TOOLS:
            return PolicyDecision(True, requires_approval=True, reason=f"工具「{tool_name}」为敏感操作，需人工审批")
        return PolicyDecision(True)


# 用户（人类）通过 API 直接请求执行的工具，同样受敏感工具审批约束
def is_sensitive(tool_name: str) -> bool:
    return tool_name in SENSITIVE_TOOLS
