"""命令行入口：aegis <command>"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="aegis",
        description="Aegis 企业级 AI 智能体平台（RAG + 多智能体 + MCP + HITL）",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("ingest", help="导入文档/目录到知识库").add_argument("path", help="文件或目录路径")

    ask = sub.add_parser("ask", help="向知识库提问（多智能体流水线）")
    ask.add_argument("question", help="问题")
    ask.add_argument("--json", action="store_true", help="输出完整 JSON")

    sub.add_parser("kb", help="知识库文档与分片统计")

    serve = sub.add_parser("serve", help="启动 FastAPI 服务")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)

    sub.add_parser("mcp-server", help="以标准 stdio 方式运行 MCP 工具服务器")

    demo = sub.add_parser("demo", help="运行端到端演示（自动生成样例文档 → 入库 → 问答 → 审批）")
    demo.add_argument("--keep-data", action="store_true", help="保留演示数据（默认清理）")

    sub.add_parser("tools", help="列出 MCP 工具目录")

    apr = sub.add_parser("approvals", help="列出待审批的审批单")
    apr.add_argument("--all", action="store_true", help="包含已处理的审批单")

    apv = sub.add_parser("approve", help="批准一张审批单")
    apv.add_argument("approval_id", help="审批单 ID")
    apv.add_argument("--note", default="", help="审批备注")

    rej = sub.add_parser("reject", help="拒绝一张审批单")
    rej.add_argument("approval_id", help="审批单 ID")
    rej.add_argument("--note", default="", help="拒绝原因")

    res = sub.add_parser("resume", help="恢复被挂起的会话")
    res.add_argument("session_id", help="会话 ID")
    return p


async def _cmd_ingest(path: str) -> None:
    from aegis.ingestion import IngestionPipeline

    pipe = IngestionPipeline()
    p = Path(path)
    if p.is_dir():
        recs = pipe.ingest_directory(p)
    else:
        recs = [pipe.ingest_file(p)]
    for r in recs:
        print(f"✅ {r.file_name}: {r.chunk_count} 个分片 → {r.doc_id}")


async def _cmd_ask(question: str, as_json: bool) -> None:
    from aegis.orchestrator import Orchestrator

    orch = Orchestrator()
    session = orch.new_session(question)
    session = await orch.run(session)
    if session.state == "awaiting_approval":
        print("⏸ 会话因敏感操作挂起，等待人工审批：")
        for aid in session.pending_approval_ids:
            ap = orch.approvals.get(aid)
            print(f"  审批单 {aid}: 工具={ap.tool} 参数={json.dumps(ap.args, ensure_ascii=False)} 原因={ap.reason}")
        print(f"   审批: aegis approve {aid}  拒绝: aegis reject {aid}")
        print(f"   审批后恢复: aegis resume {session.session_id}")
    elif session.state == "failed":
        print(f"❌ 执行失败: {session.error}")
    else:
        print(session.final_answer or "（无答案）")
        if as_json:
            print("\n--- 会话 JSON ---")
            print(json.dumps(session.to_dict(), ensure_ascii=False, indent=2))
    await orch.close()


async def _cmd_kb() -> None:
    from aegis.ingestion import IngestionPipeline

    pipe = IngestionPipeline()
    stats = pipe.stats()
    print(f"文档数: {stats['documents']}，分片数: {stats['chunks']}")
    for f in stats["files"]:
        print(f"  - {f}")


def _cmd_serve(host: str, port: int) -> None:
    import uvicorn

    uvicorn.run("aegis.api.server:app", host=host, port=port)


def _cmd_mcp_server() -> None:
    from aegis.mcp.server import run_stdio_server

    run_stdio_server()


async def _cmd_demo(keep_data: bool) -> None:
    from aegis.demo import run_demo

    await run_demo(keep_data=keep_data)


async def _cmd_tools() -> None:
    from aegis.orchestrator import Orchestrator

    orch = Orchestrator()
    await orch.ensure_connected()
    for t in orch.mcp.tool_catalog():
        print(f"- {t['name']}: {t['description']}")
    await orch.close()


async def _cmd_approvals(all_: bool) -> None:
    from aegis.hitl import ApprovalManager

    mgr = ApprovalManager()
    items = mgr.list() if all_ else mgr.list(status="pending")
    if not items:
        print("（无审批单）")
        return
    for a in items:
        print(
            f"[{a.status}] {a.approval_id}  会话={a.session_id}  工具={a.tool} "
            f"参数={json.dumps(a.args, ensure_ascii=False)}  原因={a.reason}"
        )


def _cmd_decide(approval_id: str, approve: bool, note: str) -> None:
    from aegis.hitl import ApprovalManager

    mgr = ApprovalManager()
    ap = mgr.decide(approval_id, approve, by="human", note=note)
    print(f"✅ 审批单 {ap.approval_id} → {ap.status}")


async def _cmd_resume(session_id: str) -> None:
    from aegis.orchestrator import Orchestrator

    orch = Orchestrator()
    session = orch.sessions.get(session_id)
    if session is None:
        print(f"❌ 会话不存在: {session_id}")
        return
    session = await orch.resume(session)
    if session.state == "awaiting_approval":
        print("⏸ 仍有未决定的审批单，请先 approve/reject")
    elif session.state == "failed":
        print(f"❌ 执行失败: {session.error}")
    else:
        print(session.final_answer or "（无答案）")
    await orch.close()


def main(argv: list[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    if args.command == "ingest":
        asyncio.run(_cmd_ingest(args.path))
    elif args.command == "ask":
        asyncio.run(_cmd_ask(args.question, args.json))
    elif args.command == "kb":
        asyncio.run(_cmd_kb())
    elif args.command == "serve":
        _cmd_serve(args.host, args.port)
    elif args.command == "mcp-server":
        _cmd_mcp_server()
    elif args.command == "demo":
        asyncio.run(_cmd_demo(args.keep_data))
    elif args.command == "tools":
        asyncio.run(_cmd_tools())
    elif args.command == "approvals":
        asyncio.run(_cmd_approvals(args.all))
    elif args.command == "approve":
        _cmd_decide(args.approval_id, True, args.note)
    elif args.command == "reject":
        _cmd_decide(args.approval_id, False, args.note)
    elif args.command == "resume":
        asyncio.run(_cmd_resume(args.session_id))
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
