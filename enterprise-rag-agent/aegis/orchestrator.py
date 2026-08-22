"""多智能体编排器 —— 状态机驱动的协作流水线。

flow:
  planning → retrieving → answering → auditing
      ↑_______________ revise（带审计反馈，最多 max_audit_rounds 轮）
      ↓
  done（终答 = 草稿 + 审计结论 + 引用来源）

HITL：敏感 MCP 工具在 retrieving/auditing 阶段触发审批时，
会话挂起为 awaiting_approval；人工 approve/reject 后 resume 继续执行。
"""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aegis.agents import (
    AnswererAgent,
    AuditorAgent,
    PlannerAgent,
    RetrieverAgent,
    evidence_from_dict,
    evidence_to_dict,
)
from aegis.config import get_settings
from aegis.embeddings import EmbeddingProvider
from aegis.hitl import ApprovalManager
from aegis.llm import LLMProvider, build_llm
from aegis.mcp import MCPToolClient, PendingToolCall
from aegis.mcp.client import ApprovalOutcome
from aegis.retrieval import ChromaStore, EvidenceItem, HybridRetriever


class ApprovalRequired(Exception):
    """敏感工具触发 HITL 审批，会话挂起。"""

    def __init__(self, approval_id: str) -> None:
        super().__init__(f"需要人工审批: {approval_id}")
        self.approval_id = approval_id


@dataclass
class Session:
    session_id: str
    question: str
    state: str = "planning"  # planning|retrieving|answering|auditing|awaiting_approval|done|failed
    resume_state: str = ""
    plan: dict[str, Any] | None = None
    evidence: list[dict[str, Any]] = field(default_factory=list)
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    draft: str | None = None
    audit: dict[str, Any] | None = None
    audit_history: list[dict[str, Any]] = field(default_factory=list)
    rounds: int = 0
    feedback: str = ""
    final_answer: str | None = None
    sources: list[str] = field(default_factory=list)
    pending_approval_ids: list[str] = field(default_factory=list)
    error: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        d = dict(self.__dict__)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Session":
        s = cls(session_id=d["session_id"], question=d["question"])
        for k, v in d.items():
            if hasattr(s, k):
                setattr(s, k, v)
        return s


class SessionStore:
    """会话持久化（JSON）。"""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}

    def save(self, session: Session) -> None:
        session.updated_at = datetime.now(timezone.utc).isoformat()
        with self._lock:
            data = self._load()
            data[session.session_id] = session.to_dict()
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def get(self, session_id: str) -> Session | None:
        d = self._load().get(session_id)
        return Session.from_dict(d) if d else None

    def list(self) -> list[Session]:
        return [Session.from_dict(d) for d in self._load().values()]


class Orchestrator:
    def __init__(
        self,
        *,
        llm: LLMProvider | None = None,
        embeddings: EmbeddingProvider | None = None,
        vector_store: ChromaStore | None = None,
        data_dir: Path | None = None,
    ) -> None:
        self.settings = get_settings()
        self.data_dir = Path(data_dir) if data_dir else self.settings.data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)

        self.llm = llm or build_llm()
        self.hybrid = HybridRetriever(embeddings=embeddings, vector_store=vector_store)
        self.approvals = ApprovalManager(self.data_dir / "approvals.json")
        self.sessions = SessionStore(self.data_dir / "sessions.json")

        self.mcp = MCPToolClient(approval_callback=self._approval_callback)

        self.planner = PlannerAgent(self.llm)
        self.retriever_agent = RetrieverAgent(self.llm, hybrid=self.hybrid, mcp_client=self.mcp)
        self.answerer = AnswererAgent(self.llm)
        self.auditor = AuditorAgent(self.llm)

        self._connected = False
        self._current_session_id: str = ""

    # ---------------- HITL 审批回调 ----------------

    async def _approval_callback(self, pending: PendingToolCall) -> ApprovalOutcome:
        mode = self.settings.hitl_mode
        sid = self._current_session_id or "none"
        if mode == "auto_approve":
            return ApprovalOutcome(True, "auto_approve 模式自动放行")
        if mode == "auto_deny":
            return ApprovalOutcome(False, "auto_deny 模式默认拒绝")
        # interactive：重放既往决定，否则创建审批单并挂起
        existing = self.approvals.find_for(sid, pending.tool, pending.args)
        if existing is not None and existing.status == "approved":
            return ApprovalOutcome(True, "人工已批准（重放）")
        if existing is not None and existing.status == "rejected":
            return ApprovalOutcome(False, "人工已拒绝")
        approval = self.approvals.create(sid, pending)
        raise ApprovalRequired(approval.approval_id)

    # ---------------- 生命周期 ----------------

    async def ensure_connected(self) -> None:
        if not self._connected:
            await self.mcp.connect(retriever=self.hybrid)
            self._connected = True

    async def close(self) -> None:
        await self.mcp.close()
        self._connected = False

    # ---------------- 会话入口 ----------------

    def new_session(self, question: str) -> Session:
        session = Session(session_id=f"ses_{uuid.uuid4().hex[:12]}", question=question)
        self.sessions.save(session)
        return session

    async def run(self, session: Session) -> Session:
        """推进会话直到终态或挂起。"""
        await self.ensure_connected()
        self._current_session_id = session.session_id
        try:
            while session.state not in ("done", "failed", "awaiting_approval"):
                await self._step(session)
                self.sessions.save(session)
        finally:
            self._current_session_id = ""
        return session

    async def resume(self, session: Session) -> Session:
        """人工审批后恢复执行。"""
        await self.ensure_connected()
        if session.state != "awaiting_approval":
            return await self.run(session)
        # 检查所有 pending 审批是否已决定
        undecided = [a for a in session.pending_approval_ids if self.approvals.get(a).status == "pending"]
        if undecided:
            return session  # 仍有未决定审批，继续等待
        session.pending_approval_ids = []
        session.state = session.resume_state or "retrieving"
        return await self.run(session)

    # ---------------- 状态机 ----------------

    async def _step(self, session: Session) -> None:
        handler = {
            "planning": self._step_planning,
            "retrieving": self._step_retrieving,
            "answering": self._step_answering,
            "auditing": self._step_auditing,
        }.get(session.state)
        if handler is None:
            session.state = "failed"
            session.error = f"未知状态: {session.state}"
            return
        try:
            await handler(session)
        except ApprovalRequired as exc:
            session.pending_approval_ids.append(exc.approval_id)
            session.resume_state = session.state
            session.state = "awaiting_approval"
        except Exception as exc:  # noqa: BLE001
            session.state = "failed"
            session.error = f"{type(exc).__name__}: {exc}"

    async def _step_planning(self, session: Session) -> None:
        catalog = self.mcp.tool_catalog()
        plan = self.planner.make_plan(session.question, catalog)
        session.plan = {
            "needs_retrieval": plan.needs_retrieval,
            "sub_questions": plan.sub_questions,
            "tools_to_call": plan.tools_to_call,
            "reasoning": plan.reasoning,
        }
        session.state = "retrieving"

    async def _step_retrieving(self, session: Session) -> None:
        from aegis.agents import Plan

        plan = Plan(**session.plan) if session.plan else Plan(sub_questions=[session.question])
        # 审计反馈要求补充检索 → 追加 missing_topics 子问题
        if session.feedback and session.audit:
            for topic in session.audit.get("missing_topics", []):
                if topic not in plan.sub_questions:
                    plan.sub_questions.append(topic)
        bundle = await self.retriever_agent.retrieve(plan)
        session.evidence = evidence_to_dict(bundle.evidence)
        session.tool_results = [r.__dict__ for r in bundle.tool_results]
        session.state = "answering"

    async def _step_answering(self, session: Session) -> None:
        evidence = evidence_from_dict(session.evidence)
        tool_text = "\n".join(
            f"- {r['tool']}: {r.get('output') or r.get('error')}" for r in session.tool_results
        )
        session.draft = self.answerer.answer(
            session.question,
            evidence,
            tool_results_text=tool_text,
            feedback=session.feedback,
        )
        session.state = "auditing"

    async def _step_auditing(self, session: Session) -> None:
        evidence = evidence_from_dict(session.evidence)
        tool_text = "\n".join(
            f"- {r['tool']}: {r.get('output') or r.get('error')}" for r in session.tool_results
        )
        report = self.auditor.audit(
            session.question,
            session.draft or "",
            evidence,
            tool_results_text=tool_text,
        )
        session.audit = report.to_dict()
        session.audit_history.append(report.to_dict())

        # 审计者可补充检索复核（自我修正的检索侧）
        if report.verdict == "revise" and report.missing_topics and session.rounds < self.settings.max_audit_rounds:
            extras: list[EvidenceItem] = []
            for topic in report.missing_topics[:2]:
                for item in self.hybrid.search(topic, top_k=2):
                    if item.chunk_id not in {e["chunk_id"] for e in session.evidence}:
                        extras.append(item)
            if extras:
                session.evidence = evidence_to_dict(evidence + extras)

        threshold = self.settings.auditor_score_threshold
        if report.verdict == "pass" or report.score >= threshold:
            session.final_answer = self._compose_final(session, report)
            session.state = "done"
        elif session.rounds >= self.settings.max_audit_rounds:
            session.final_answer = self._compose_final(session, report, force_note=True)
            session.state = "done"
        else:
            session.rounds += 1
            session.feedback = report.feedback or "请依据证据重新回答"
            session.state = "retrieving"

    # ---------------- 终答组装 ----------------

    @staticmethod
    def _compose_final(session: Session, report: Any, *, force_note: bool = False) -> str:
        parts = [session.draft or ""]
        verdict = getattr(report, "verdict", "pass")
        score = getattr(report, "score", 0.0)
        feedback = getattr(report, "feedback", "")
        # 审计多轮仍判定证据不足/相关性不足 → 如实告知，绝不编造
        if force_note and (score < 0.5 or "相关性不足" in feedback or "证据不足" in feedback):
            return (
                f"经 {session.rounds + 1} 轮检索与事实核查，知识库中没有与您的问题直接相关的可靠依据，"
                f"因此无法给出可信回答。建议补充相关文档后再试。\n\n"
                f"🔎 审核意见：{feedback or '证据不足'}"
            )
        if force_note:
            parts.append(
                f"\n\n⚠️ 审核说明：经过 {session.rounds} 轮修订后仍有部分内容未完全通过事实核查，"
                f"请以上方引用来源为准，审慎使用。"
            )
        elif verdict == "pass":
            parts.append(f"\n\n✅ 事实核查通过（可信度 {score:.0%}，共 {len(session.audit_history)} 轮审核）。")
        # 引用来源
        seen: set[str] = set()
        srcs: list[str] = []
        for e in session.evidence:
            key = e["file_name"]
            if key not in seen:
                seen.add(key)
                srcs.append(f"- 《{e['file_name']}》")
        if srcs:
            parts.append("\n\n📚 引用来源：\n" + "\n".join(srcs))
        return "\n".join(parts)

    # ---------------- HITL API ----------------

    def decide_approval(self, approval_id: str, approve: bool, *, by: str = "human", note: str = "") -> Any:
        return self.approvals.decide(approval_id, approve, by=by, note=note)

    def pending_approvals(self) -> list[Any]:
        return self.approvals.list(status="pending")
