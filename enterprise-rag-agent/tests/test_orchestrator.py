"""编排器集成测试：多智能体流水线 + HITL 挂起/恢复（离线 scripted LLM）。"""

import pytest

from aegis.ingestion import IngestionPipeline
from aegis.orchestrator import Orchestrator


@pytest.fixture()
async def orch(aegis_env, sample_docs):
    pipeline = IngestionPipeline()
    pipeline.ingest_directory(sample_docs[0].parent)
    o = Orchestrator()
    await o.ensure_connected()
    yield o
    await o.close()


@pytest.mark.asyncio
async def test_kb_question_flow(orch):
    s = orch.new_session("一线城市出差住宿报销上限是多少？")
    s = await orch.run(s)
    assert s.state == "done", s.error
    assert s.final_answer and "600" in s.final_answer
    assert any("差旅报销制度" in e["file_name"] for e in s.evidence)
    assert s.audit is not None


@pytest.mark.asyncio
async def test_calculator_tool_flow(orch):
    s = orch.new_session("算式: 2^10 等于多少？")
    s = await orch.run(s)
    assert s.state == "done", s.error
    assert "1024" in (s.final_answer or "") or "1024" in str(s.tool_results)


@pytest.mark.asyncio
async def test_no_evidence_no_fabrication(orch):
    s = orch.new_session("公司食堂晚餐几点开饭？")
    s = await orch.run(s)
    assert s.state == "done", s.error
    assert "依据" in (s.final_answer or "") and "没有" in (s.final_answer or "")


@pytest.mark.asyncio
async def test_hitl_suspend_resume(orch):
    question = (
        '请发邮件通知 HR。 [ACTION] {"tool": "send_email", "args": '
        '{"to": "hr@x.com", "subject": "通知", "body": "测试"}}'
    )
    s = orch.new_session(question)
    s = await orch.run(s)
    assert s.state == "awaiting_approval"
    assert len(s.pending_approval_ids) == 1

    aid = s.pending_approval_ids[0]
    orch.decide_approval(aid, True, note="批准")
    s = await orch.resume(s)
    assert s.state == "done", s.error
    assert any("已发送" in r.get("output", "") for r in s.tool_results)


@pytest.mark.asyncio
async def test_hitl_reject(orch):
    question = (
        '请删除文档。 [ACTION] {"tool": "delete_document", "args": {"doc_id": "doc_x"}}'
    )
    s = orch.new_session(question)
    s = await orch.run(s)
    assert s.state == "awaiting_approval"
    aid = s.pending_approval_ids[0]
    orch.decide_approval(aid, False, note="拒绝")
    s = await orch.resume(s)
    assert s.state == "done", s.error
    assert all(r["status"] == "denied" for r in s.tool_results if r["tool"] == "delete_document")


@pytest.mark.asyncio
async def test_session_persistence(orch):
    s = orch.new_session("一线城市出差住宿报销上限是多少？")
    s = await orch.run(s)
    assert s.state == "done"
    restored = orch.sessions.get(s.session_id)
    assert restored is not None and restored.final_answer == s.final_answer
