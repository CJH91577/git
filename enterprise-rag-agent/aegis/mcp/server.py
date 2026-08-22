"""MCP 工具服务器（基于官方 Model Context Protocol SDK）。

工具一览：
- 安全工具: calculator（AST 白名单数学计算）/ get_current_time / kb_search / doc_stats
- 敏感工具（需 HITL 审批）: send_email / export_file / delete_document

独立运行: python -m aegis.mcp.server （标准 stdio MCP 服务，可被任意 MCP 客户端接入）
"""

from __future__ import annotations

import ast
import operator
import re
from datetime import datetime

from mcp.server import MCPServer

# 敏感工具：涉及外部影响/不可逆操作，必须经过人工审批（见 policy.py）
SENSITIVE_TOOLS: set[str] = {"send_email", "export_file", "delete_document"}


# ---------------- 安全计算器 ----------------

_SAFE_NODES = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Name, ast.Load,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod,
    ast.USub, ast.UAdd, ast.Call,
)
_SAFE_FUNCS = {
    "abs": abs, "round": round, "min": min, "max": max,
    "sqrt": lambda x: x ** 0.5, "pow": pow,
}
_BINARY_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod,
}
_UNARY_OPS = {ast.USub: operator.neg, ast.UAdd: operator.pos}


def _safe_eval(expression: str) -> float:
    """AST 白名单求值：拒绝一切未授权节点，杜绝 eval 注入。"""
    expr = re.sub(r"[×xX]", "*", expression).replace("÷", "/").replace("^", "**").strip()
    if not expr or len(expr) > 200:
        raise ValueError("表达式为空或过长")
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"表达式语法非法: {exc.msg}") from exc
    for node in ast.walk(tree):
        if not isinstance(node, _SAFE_NODES):
            raise ValueError(f"表达式包含不允许的语法: {type(node).__name__}")
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _SAFE_FUNCS:
                raise ValueError(f"不允许调用函数: {getattr(node.func, 'id', '?')}")
            if node.keywords:
                raise ValueError("不允许关键字参数")

    def ev(node: ast.AST) -> float:
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.BinOp):
            return _BINARY_OPS[type(node.op)](ev(node.left), ev(node.right))
        if isinstance(node, ast.UnaryOp):
            return _UNARY_OPS[type(node.op)](ev(node.operand))
        if isinstance(node, ast.Call):
            args = [ev(a) for a in node.args]
            return float(_SAFE_FUNCS[node.func.id](*args))
        raise ValueError("无法求值的表达式")

    return ev(tree.body)


# ---------------- 工具定义 ----------------

def create_mcp_server(retriever=None) -> MCPServer:
    """创建 MCP 服务器；retriever 供 kb_search 工具使用。

    每次调用返回新实例（工具闭包绑定各自的 retriever），
    避免跨会话/跨数据目录的状态串扰。
    """
    mcp = MCPServer(
        name="aegis-tools",
        version="0.1.0",
        instructions="Aegis 企业智能体平台工具服务器。敏感工具(send_email/export_file/delete_document)需人工审批。",
    )
    _retriever = retriever

    @mcp.tool(name="calculator", description="安全计算数学表达式，仅支持四则运算、幂、取模与 sqrt/abs/round/min/max 等函数。")
    def calculator(expression: str) -> str:
        """计算数学表达式（AST 白名单，无注入风险）。非法表达式抛出错误。"""
        try:
            return f"{_safe_eval(expression):g}"
        except ZeroDivisionError as exc:
            raise ValueError("除数为零") from exc
        except ValueError:
            raise

    @mcp.tool(name="get_current_time", description="获取当前日期时间。")
    def get_current_time() -> str:
        """返回当前日期时间。"""
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    @mcp.tool(name="kb_search", description="在已入库的企业知识库中做语义检索，返回带来源的最相关片段。")
    def kb_search(query: str, top_k: int = 4) -> str:
        """检索企业知识库（需先通过入库管道导入文档）。"""
        if _retriever is None:
            from aegis.retrieval import HybridRetriever

            ret = HybridRetriever()
        else:
            ret = _retriever
        if ret.store.count() == 0:
            return "知识库为空，请先导入文档。"
        items = ret.search(query, top_k=max(1, min(int(top_k), 10)))
        if not items:
            return "未找到相关内容。"
        lines = []
        for i, it in enumerate(items, 1):
            lines.append(f"[{i}] {it.describe()}\n{it.text[:500]}")
        return "\n\n".join(lines)

    @mcp.tool(name="doc_stats", description="查看知识库文档与分片统计。")
    def doc_stats() -> str:
        """知识库统计信息。"""
        if _retriever is None:
            from aegis.retrieval import HybridRetriever

            ret = HybridRetriever()
        else:
            ret = _retriever
        from aegis.config import get_settings
        from aegis.ingestion.pipeline import DocRegistry

        registry = DocRegistry(get_settings().data_dir / "doc_registry.json")
        docs = registry.list()
        lines = [f"文档数: {len(docs)}，分片总数: {ret.store.count()}"]
        for d in docs:
            lines.append(f"- {d['file_name']}（{d['chunk_count']} 分片，{d['ingested_at'][:10]} 入库）")
        return "\n".join(lines)

    @mcp.tool(name="send_email", description="【敏感·需人工审批】模拟发送邮件（不会真实发送，仅演示 HITL 审批流程）。")
    def send_email(to: str, subject: str, body: str) -> str:
        """模拟发送邮件。"""
        return f"[模拟] 邮件已发送 → 收件人: {to}，主题: {subject}"

    @mcp.tool(name="export_file", description="【敏感·需人工审批】将内容导出为文件（仅允许写入指定导出目录）。")
    def export_file(file_name: str, content: str) -> str:
        """将内容导出到导出目录。"""
        import re as _re
        from pathlib import Path

        from aegis.config import get_settings

        safe_name = _re.sub(r"[^\w.\-]", "_", file_name)
        if not safe_name or safe_name.startswith("."):
            return "错误: 非法文件名"
        export_dir = get_settings().data_dir / "exports"
        export_dir.mkdir(parents=True, exist_ok=True)
        out = export_dir / safe_name
        out.write_text(content, encoding="utf-8")
        return f"已导出: {out}"

    @mcp.tool(name="delete_document", description="【敏感·需人工审批】从知识库删除指定文档。")
    def delete_document(doc_id: str) -> str:
        """删除知识库文档。"""
        if _retriever is None:
            from aegis.retrieval import HybridRetriever

            ret = HybridRetriever()
        else:
            ret = _retriever
        from aegis.ingestion.pipeline import IngestionPipeline

        pipe = IngestionPipeline(embeddings=None, vector_store=ret.store)
        pipe.delete_document(doc_id)
        return f"文档 {doc_id} 已删除。"

    return mcp


def run_stdio_server() -> None:
    """以标准 stdio 方式运行 MCP 服务器（供外部 MCP 客户端接入）。"""
    mcp = create_mcp_server()
    mcp.run(transport="stdio")
