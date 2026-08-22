"""FastAPI 服务：文档入库、问答、HITL 审批、MCP 工具网关。"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from aegis.config import get_settings
from aegis.ingestion import IngestionPipeline
from aegis.orchestrator import ApprovalRequired, Orchestrator

_app: Orchestrator | None = None
_pipeline: IngestionPipeline | None = None
_init_lock = asyncio.Lock()


async def get_orchestrator() -> Orchestrator:
    global _app
    if _app is None:
        async with _init_lock:
            if _app is None:
                _app = Orchestrator()
    return _app


def get_pipeline() -> IngestionPipeline:
    global _pipeline
    if _pipeline is None:
        s = get_settings()
        _pipeline = IngestionPipeline(data_dir=s.data_dir)
    return _pipeline


app = FastAPI(
    title="Aegis 企业级 AI 智能体平台",
    description=(
        "多格式文档 RAG · 多智能体协作(Planner/Retriever/Auditor/Answerer) · "
        "MCP 工具调用与安全隔离 · 事实核查自修正 · HITL 人工审批"
    ),
    version="0.1.0",
)


# ---------------- 模型 ----------------

class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, description="用户问题")


class ChatResponse(BaseModel):
    session_id: str
    state: str
    final_answer: str | None = None
    audit: dict[str, Any] | None = None
    rounds: int = 0
    pending_approvals: list[dict[str, Any]] = []
    error: str | None = None


class ApprovalDecision(BaseModel):
    approve: bool
    note: str = ""


class ToolCallRequest(BaseModel):
    tool: str
    args: dict[str, Any] = {}
    user: str = "api"


# ---------------- 健康检查 ----------------

@app.get("/health")
async def health() -> dict[str, Any]:
    orch = await get_orchestrator()
    return {
        "status": "ok",
        "kb": orch.hybrid.stats(),
        "pending_approvals": len(orch.pending_approvals()),
    }


# ---------------- 文档管理 ----------------

@app.post("/api/documents/ingest")
async def ingest(file: UploadFile = File(...)) -> dict[str, Any]:
    s = get_settings()
    s.ensure_dirs()
    dest = s.upload_dir / Path(file.filename or "upload.bin").name
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    try:
        rec = await asyncio.to_thread(get_pipeline().ingest_file, dest)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"入库失败: {exc}") from exc
    return {"doc_id": rec.doc_id, "file_name": rec.file_name, "chunk_count": rec.chunk_count}


@app.post("/api/documents/ingest-path")
async def ingest_path(path: str) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"路径不存在: {path}")
    try:
        if p.is_dir():
            recs = await asyncio.to_thread(get_pipeline().ingest_directory, p)
        else:
            recs = [await asyncio.to_thread(get_pipeline().ingest_file, p)]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"入库失败: {exc}") from exc
    return {"ingested": [r.file_name for r in recs], "chunks": sum(r.chunk_count for r in recs)}


@app.get("/api/documents")
async def list_documents() -> list[dict[str, Any]]:
    return get_pipeline().list_documents()


@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: str) -> dict[str, Any]:
    """删除文档属于敏感操作：走 HITL 审批。"""
    orch = await get_orchestrator()
    await orch.ensure_connected()
    try:
        result = await orch.mcp.call_tool_as_user("delete_document", {"doc_id": doc_id}, user="api")
    except ApprovalRequired as exc:
        return {"status": "awaiting_approval", "approval_id": exc.approval_id,
                "hint": "审批通过后重新调用本接口即可完成删除"}
    if not result.ok:
        raise HTTPException(status_code=403, detail=result.error)
    return {"status": "deleted", "detail": result.output}


# ---------------- 问答 ----------------

@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    orch = await get_orchestrator()
    session = orch.new_session(req.question)
    session = await orch.run(session)
    return _session_response(session)


def _session_response(session: Any) -> ChatResponse:
    orch_pending = []
    for a in session.pending_approval_ids:
        ap = _app.approvals.get(a) if _app else None
        if ap:
            orch_pending.append(ap.to_dict())
    return ChatResponse(
        session_id=session.session_id,
        state=session.state,
        final_answer=session.final_answer,
        audit=session.audit,
        rounds=session.rounds,
        pending_approvals=orch_pending,
        error=session.error,
    )


@app.get("/api/sessions/{session_id}", response_model=ChatResponse)
async def get_session(session_id: str) -> ChatResponse:
    orch = await get_orchestrator()
    session = orch.sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    return _session_response(session)


@app.post("/api/sessions/{session_id}/resume", response_model=ChatResponse)
async def resume_session(session_id: str) -> ChatResponse:
    orch = await get_orchestrator()
    session = orch.sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    session = await orch.resume(session)
    return _session_response(session)


# ---------------- HITL 审批 ----------------

@app.get("/api/approvals")
async def list_approvals(status: str | None = None) -> list[dict[str, Any]]:
    orch = await get_orchestrator()
    return [a.to_dict() for a in orch.approvals.list(status=status)]


@app.post("/api/approvals/{approval_id}/decide")
async def decide_approval(approval_id: str, req: ApprovalDecision) -> dict[str, Any]:
    orch = await get_orchestrator()
    try:
        approval = orch.decide_approval(approval_id, req.approve, by="human", note=req.note)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return approval.to_dict()


# ---------------- MCP 工具网关（人工调用入口） ----------------

@app.get("/api/tools")
async def list_tools() -> list[dict[str, Any]]:
    orch = await get_orchestrator()
    await orch.ensure_connected()
    return orch.mcp.tool_catalog()


@app.post("/api/tools/call")
async def call_tool(req: ToolCallRequest) -> dict[str, Any]:
    orch = await get_orchestrator()
    await orch.ensure_connected()
    try:
        result = await orch.mcp.call_tool_as_user(req.tool, req.args, user=req.user)
    except ApprovalRequired as exc:
        return {"status": "awaiting_approval", "approval_id": exc.approval_id,
                "hint": "审批通过后重新调用本接口即可完成执行"}
    if not result.ok:
        raise HTTPException(status_code=403, detail=result.error)
    return {"status": "done", "output": result.output}
