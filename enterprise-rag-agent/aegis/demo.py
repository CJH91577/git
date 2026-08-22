"""端到端演示与自验证：生成样例文档 → 入库 → 检索 → 多智能体问答 → MCP → 安全隔离 → HITL → 审核防幻觉。

每步带断言，验证失败抛异常并给出失败摘要。
运行: python -m aegis.demo [--keep-data]
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from aegis.config import get_settings, reset_settings
from aegis.hitl import ApprovalManager
from aegis.ingestion import IngestionPipeline
from aegis.mcp.policy import ToolSecurityPolicy
from aegis.orchestrator import Orchestrator
from aegis.retrieval import HybridRetriever


class VerifyError(AssertionError):
    pass


def check(cond: bool, label: str, detail: str = "") -> None:
    status = "✅ PASS" if cond else "❌ FAIL"
    print(f"  [{status}] {label}" + (f" —— {detail}" if detail else ""))
    if not cond:
        raise VerifyError(f"{label}: {detail}")


def banner(title: str) -> None:
    print(f"\n{'=' * 64}\n  {title}\n{'=' * 64}")


async def run_demo(*, keep_data: bool = False, quiet: bool = False) -> dict:
    """运行完整演示。返回验证摘要。"""
    results: list[str] = []
    if quiet:
        import contextlib
        import io

        sink = contextlib.redirect_stdout(io.StringIO())
        sink.__enter__()

    tmp = Path(tempfile.mkdtemp(prefix="aegis_demo_"))
    data_dir = tmp / "data"
    samples_dir = tmp / "samples"

    try:
        # 隔离演示环境：临时数据目录 + scripted LLM（离线可复现）
        import os

        os.environ["AEGIS_DATA_DIR"] = str(data_dir)
        os.environ["AEGIS_CHROMA_DIR"] = str(data_dir / "chroma")
        os.environ["AEGIS_LLM_PROVIDER"] = "scripted"
        os.environ["AEGIS_HITL_MODE"] = "interactive"
        os.environ["AEGIS_MCP_TRANSPORT"] = "inprocess"
        reset_settings()
        settings = get_settings()
        settings.ensure_dirs()

        # ---------- 阶段 0：生成样例文档 ----------
        banner("阶段 0 · 生成样例文档（PDF/Word/Excel/PPT/TXT）")
        import runpy
        import sys as _sys

        samples_dir.mkdir(parents=True, exist_ok=True)
        old_argv = _sys.argv
        _sys.argv = ["make_sample_docs.py", str(samples_dir)]
        try:
            ns = runpy.run_path(
                str(Path(__file__).resolve().parent.parent / "scripts" / "make_sample_docs.py"),
                run_name="__sample_docs__",
            )
            ns["main"]()  # run_name 非 __main__，需显式调用入口
        finally:
            _sys.argv = old_argv
        sample_files = sorted(samples_dir.iterdir())
        check(len(sample_files) == 5, "5 种格式文档生成", ", ".join(p.name for p in sample_files))
        results.append("样例文档生成")

        # ---------- 阶段 1：入库 ----------
        banner("阶段 1 · 多格式文档入库（解析 → 切块 → 向量化 → Chroma）")
        pipeline = IngestionPipeline(data_dir=data_dir)
        recs = pipeline.ingest_directory(samples_dir)
        for r in recs:
            print(f"    📥 {r.file_name}: {r.chunk_count} 分片")
        check(len(recs) == 5, "5 个文档全部入库")
        total_chunks = pipeline.stats()["chunks"]
        check(total_chunks >= 5, "切块总数合理", f"{total_chunks} chunks")
        results.append("文档入库")

        # ---------- 阶段 2：混合检索 ----------
        banner("阶段 2 · 语义检索（向量 + BM25 混合）")
        retriever = HybridRetriever(embeddings=pipeline.embeddings, vector_store=pipeline.store)
        hits = retriever.search("一线城市出差住宿报销上限是多少？", top_k=4)
        check(len(hits) > 0, "检索返回结果", f"{len(hits)} 条")
        top_names = {h.file_name for h in hits[:2]}
        check("差旅报销制度.docx" in top_names, "命中最相关文档《差旅报销制度.docx》", str(top_names))
        check(any("600" in h.text for h in hits), "证据包含关键数字「600 元」")
        results.append("混合检索")

        # ---------- 阶段 3：MCP 工具 + 安全隔离 ----------
        banner("阶段 3 · MCP 工具调用与安全隔离")
        orch = Orchestrator(data_dir=data_dir)
        await orch.ensure_connected()

        r_calc = await orch.mcp.call_tool("calculator", {"expression": "12*8+6"}, agent="retriever")
        check(r_calc.ok and r_calc.output == "102", "calculator 工具调用", f"12*8+6 = {r_calc.output}")

        r_deny = await orch.mcp.call_tool("calculator", {"expression": "1+1"}, agent="answerer")
        check(r_deny.status == "denied" and "无权" in r_deny.error, "安全隔离：answerer 无权调用工具被拒", r_deny.error[:60])

        r_inject = await orch.mcp.call_tool("calculator", {"expression": "__import__('os').system('dir')"}, agent="retriever")
        check(not r_inject.ok, "注入防护：非法表达式被拒绝", r_inject.error[:60])
        results.append("MCP 工具与安全隔离")

        # ---------- 阶段 4：多智能体问答（含计算工具） ----------
        banner("阶段 4 · 多智能体协作问答（Planner→Retriever→Auditor→Answerer）")
        s1 = orch.new_session("一线城市出差住宿报销上限是多少？")
        s1 = await orch.run(s1)
        check(s1.state == "done", "会话完成", f"state={s1.state}, rounds={s1.rounds}")
        check(s1.final_answer and "600" in s1.final_answer, "答案包含正确数字 600", (s1.final_answer or "")[:120])
        check("差旅报销制度.docx" in (s1.final_answer or ""), "答案附引用来源《差旅报销制度.docx》")
        check(s1.audit and s1.audit.get("verdict") in ("pass", "revise"), "Auditor 输出审计报告", f"score={s1.audit.get('score')}")

        s2 = orch.new_session("算式: (1000-700)*0.13 请问税额是多少？")
        s2 = await orch.run(s2)
        check("39" in (s2.final_answer or ""), "工具计算结果进入答案（(1000-700)*0.13=39）", (s2.final_answer or "")[:150])
        results.append("多智能体问答")

        # ---------- 阶段 5：审核防幻觉（证据不足 → 不编造） ----------
        banner("阶段 5 · Auditor 事实核查：证据不足时不编造")
        s3 = orch.new_session("公司食堂午餐价格是多少？")
        s3 = await orch.run(s3)
        check(s3.state == "done", "会话完成（审核循环收敛）", f"rounds={s3.rounds}")
        check(
            "没有" in (s3.final_answer or "") and "依据" in (s3.final_answer or ""),
            "知识库无相关依据时如实说明、不编造",
            (s3.final_answer or "")[:140],
        )
        results.append("审核防幻觉")

        # ---------- 阶段 6：HITL 人工审批 ----------
        banner("阶段 6 · HITL：敏感操作需人工审批")
        email_action = {
            "tool": "send_email",
            "args": {"to": "hr@nebula-tech.com", "subject": "差旅标准确认", "body": "请确认一线城市住宿标准"},
        }
        question = (
            '请把差旅住宿标准发邮件给 HR。 [ACTION] {"tool": "send_email", "args": '
            '{"to": "hr@nebula-tech.com", "subject": "差旅标准确认", "body": "请确认一线城市住宿标准"}}'
        )
        s4 = orch.new_session(question)
        s4 = await orch.run(s4)
        check(s4.state == "awaiting_approval", "敏感工具触发会话挂起", f"approvals={s4.pending_approval_ids}")
        check(len(s4.pending_approval_ids) == 1, "生成 1 张审批单")
        aid = s4.pending_approval_ids[0]
        ap = orch.approvals.get(aid)
        check(ap.tool == "send_email", "审批单工具正确", ap.tool)

        # 拒绝 → 恢复 → 邮件不发送
        orch.decide_approval(aid, False, note="演示：拒绝发送")
        s4 = await orch.resume(s4)
        check(s4.state == "done", "拒绝后会话继续完成")
        check("拒绝" in str(s4.tool_results), "拒绝记录进入工具结果")
        results.append("HITL 拒绝流")

        # 再次请求 → 挂起 → 批准 → 恢复 → 发送成功
        s5 = orch.new_session(question)
        s5 = await orch.run(s5)
        check(s5.state == "awaiting_approval", "再次触发审批挂起")
        aid2 = s5.pending_approval_ids[0]
        orch.decide_approval(aid2, True, note="演示：批准发送")
        s5 = await orch.resume(s5)
        check(s5.state == "done", "批准后会话完成")
        sent = any("已发送" in r.get("output", "") for r in s5.tool_results if r["tool"] == "send_email")
        check(sent, "批准后邮件发送成功")
        results.append("HITL 批准流")

        # ---------- 阶段 7：重复入库幂等 ----------
        banner("阶段 7 · 重复入库幂等（SHA-256 去重）")
        rec_again = pipeline.ingest_file(samples_dir / "员工手册.txt")
        stats = pipeline.stats()
        check(stats["documents"] == 5, "重复入库不产生重复文档", f"documents={stats['documents']}")
        results.append("幂等入库")

        await orch.close()

        print(f"\n🎉 演示全部通过（{len(results)}/{len(results)} 个验证组）")
        summary = {
            "passed": len(results),
            "groups": results,
            "data_dir": str(data_dir),
        }
        return summary
    finally:
        if quiet:
            try:
                sink.__exit__(None, None, None)
            except Exception:
                pass
        if not keep_data:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    import argparse
    import asyncio

    parser = argparse.ArgumentParser(description="Aegis 端到端演示")
    parser.add_argument("--keep-data", action="store_true", help="保留演示数据目录")
    args = parser.parse_args()
    asyncio.run(run_demo(keep_data=args.keep_data))
