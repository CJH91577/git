"""MCP 客户端封装：把安全策略检查 + HITL 审批织入工具调用链。

支持两种传输：
- inprocess：与 FastMCP 服务器共用进程（内存通道），零开销，默认；
- stdio：以标准 MCP stdio 协议拉起独立子进程（外部接入兼容）。
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from aegis.config import get_settings
from aegis.mcp.policy import ToolSecurityPolicy

# 审批回调：返回 ToolApproval(approved: bool, reason: str)
# orchestrator 注入 HITL 逻辑：interactive 模式下挂起会话等待人工决定
ToolApprovalCallback = Callable[["PendingToolCall"], Awaitable["ApprovalOutcome"]]


@dataclass
class PendingToolCall:
    tool: str
    args: dict[str, Any]
    agent: str
    reason: str
    approval_id: str = ""


@dataclass
class ApprovalOutcome:
    approved: bool
    reason: str = ""


@dataclass
class ToolResult:
    tool: str
    args: dict[str, Any]
    status: str  # done | denied | awaiting_approval
    output: str = ""
    error: str = ""
    approval_id: str | None = None
    metadata: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == "done"

    def describe(self) -> str:
        if self.status == "done":
            return f"工具 {self.tool}({json.dumps(self.args, ensure_ascii=False)}) → {self.output}"
        if self.status == "denied":
            return f"工具 {self.tool} 被拒绝: {self.error}"
        return f"工具 {self.tool} 等待人工审批 (approval_id={self.approval_id})"


class MCPToolClient:
    """封装 MCP ClientSession + 安全策略 + HITL 审批。"""

    def __init__(
        self,
        *,
        policy: ToolSecurityPolicy | None = None,
        approval_callback: ToolApprovalCallback | None = None,
    ) -> None:
        self.policy = policy or ToolSecurityPolicy()
        self.approval_callback = approval_callback
        self._session = None
        self._server = None
        self._server_task: asyncio.Task | None = None
        self._stdio_ctx = None
        self._transport = get_settings().mcp_transport
        self._tool_schemas: list[dict[str, Any]] = []

    # ---------------- 连接 ----------------

    async def connect(self, retriever=None) -> None:
        from aegis.mcp.server import create_mcp_server

        self._server = create_mcp_server(retriever)
        if self._transport == "stdio":
            self._session = await self._connect_stdio()
        else:
            self._session = await self._connect_inprocess()
        await self._refresh_schemas()

    async def _connect_inprocess(self):
        import anyio
        from mcp import ClientSession

        s2c_send, s2c_recv = anyio.create_memory_object_stream(0)
        c2s_send, c2s_recv = anyio.create_memory_object_stream(0)
        # MCPServer 内部持有 lowlevel Server（mcp 2.x）
        mcp_server = self._server._lowlevel_server  # noqa: SLF001

        async def _run_server() -> None:
            await mcp_server.run(
                c2s_recv, s2c_send, mcp_server.create_initialization_options(), raise_exceptions=False
            )

        self._server_task = asyncio.create_task(_run_server())
        session = ClientSession(s2c_recv, c2s_send)
        await session.__aenter__()  # mcp 2.x: dispatcher 在上下文内启动
        await session.initialize()
        return session

    async def _connect_stdio(self):
        import sys

        from mcp import ClientSession, StdioServerParameters, stdio_client

        params = StdioServerParameters(
            command=sys.executable, args=["-m", "aegis.mcp.server"], env=None
        )
        self._stdio_ctx = stdio_client(params)
        read, write = await self._stdio_ctx.__aenter__()
        session = ClientSession(read, write)
        await session.__aenter__()  # mcp 2.x: dispatcher 在上下文内启动
        await session.initialize()
        return session

    async def close(self) -> None:
        if self._session is not None:
            try:
                await self._session.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001
                pass
            self._session = None
        if self._stdio_ctx is not None:
            try:
                await self._stdio_ctx.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001
                pass
            self._stdio_ctx = None
        if self._server_task is not None and not self._server_task.done():
            self._server_task.cancel()

    # ---------------- 工具目录 ----------------

    async def _refresh_schemas(self) -> None:
        tools = await self._session.list_tools()
        self._tool_schemas = [
            {
                "name": t.name,
                "description": t.description or "",
                "input_schema": getattr(t, "inputSchema", None) or getattr(t, "input_schema", {}),
            }
            for t in tools.tools
        ]

    def tool_catalog(self) -> list[dict[str, Any]]:
        """供 Planner 使用的工具目录（名称 + 说明 + 参数 schema）。"""
        return self._tool_schemas

    # ---------------- 调用 ----------------

    async def call_tool(self, tool: str, args: dict[str, Any], *, agent: str) -> ToolResult:
        """经过安全策略 + HITL 审批的工具调用。"""
        if self._session is None:
            return ToolResult(tool, args, "denied", error="MCP 客户端未连接")

        decision = self.policy.check(tool, agent)
        if not decision.ok:
            return ToolResult(tool, args, "denied", error=decision.reason)

        if decision.requires_approval:
            return await self._route_approval(tool, args, agent, decision.reason)

        return await self._invoke(tool, args)

    async def call_tool_as_user(self, tool: str, args: dict[str, Any], *, user: str) -> ToolResult:
        """人类用户通过 API 直接调用的工具（绕过智能体白名单，但仍受敏感审批约束）。"""
        from aegis.mcp.policy import is_sensitive

        if is_sensitive(tool):
            return await self._route_approval(tool, args, "human:" + user, "敏感操作，需人工审批")
        return await self._invoke(tool, args)

    async def _route_approval(self, tool: str, args: dict[str, Any], agent: str, reason: str) -> ToolResult:
        if self.approval_callback is None:
            return ToolResult(tool, args, "denied", error="未配置审批回调，敏感操作被拒绝（默认拒绝）")
        outcome = await self.approval_callback(PendingToolCall(tool, args, agent, reason))
        if not outcome.approved:
            return ToolResult(tool, args, "denied", error=f"人工审批未通过: {outcome.reason or '被拒绝'}")
        return await self._invoke(tool, args)

    async def _invoke(self, tool: str, args: dict[str, Any]) -> ToolResult:
        try:
            result = await self._session.call_tool(tool, args)
        except Exception as exc:  # noqa: BLE001
            return ToolResult(tool, args, "denied", error=f"MCP 调用失败: {exc}")
        text = ""
        for item in result.content:
            if getattr(item, "type", "") == "text":
                text += item.text
        # mcp 2.x: 工具异常被包装为 "Error executing tool <name>: ..." 文本（无 isError 字段）
        if text.startswith("Error executing tool"):
            return ToolResult(tool, args, "denied", error=text)
        return ToolResult(tool, args, "done", output=text.strip())
