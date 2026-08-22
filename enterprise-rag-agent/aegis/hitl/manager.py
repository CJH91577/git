"""HITL 人工审批管理器：敏感操作的审批记录、持久化与三种决策模式。

- interactive：挂起等待人工 approve/reject（默认，最安全）
- auto_approve：自动放行（仅限受信任环境/自动化演示）
- auto_deny：自动拒绝（默认拒绝 = fail-safe）
"""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aegis.config import get_settings
from aegis.mcp.client import PendingToolCall


@dataclass
class Approval:
    approval_id: str
    session_id: str
    tool: str
    args: dict[str, Any]
    agent: str
    reason: str
    status: str = "pending"  # pending | approved | rejected
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    decided_at: str | None = None
    decided_by: str | None = None
    decision_note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Approval":
        return cls(**{k: d.get(k) for k in cls.__dataclass_fields__})  # type: ignore[arg-type]


class ApprovalManager:
    def __init__(self, store_path: Path | None = None) -> None:
        self.path = Path(store_path) if store_path else get_settings().data_dir / "approvals.json"
        self._lock = threading.Lock()

    # ---------------- 存储 ----------------

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}

    def _save(self, data: dict[str, dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---------------- 审批流 ----------------

    def create(self, session_id: str, pending: PendingToolCall) -> Approval:
        """创建审批单；auto 模式直接定案，interactive 模式挂起。"""
        mode = get_settings().hitl_mode
        approval = Approval(
            approval_id=f"apr_{uuid.uuid4().hex[:12]}",
            session_id=session_id,
            tool=pending.tool,
            args=pending.args,
            agent=pending.agent,
            reason=pending.reason,
        )
        if mode == "auto_approve":
            approval.status = "approved"
            approval.decided_at = approval.created_at
            approval.decided_by = "system(auto)"
            approval.decision_note = "auto_approve 模式自动放行"
        elif mode == "auto_deny":
            approval.status = "rejected"
            approval.decided_at = approval.created_at
            approval.decided_by = "system(auto)"
            approval.decision_note = "auto_deny 模式自动拒绝"
        with self._lock:
            data = self._load()
            data[approval.approval_id] = approval.to_dict()
            self._save(data)
        return approval

    def decide(self, approval_id: str, approve: bool, *, by: str = "human", note: str = "") -> Approval:
        with self._lock:
            data = self._load()
            if approval_id not in data:
                raise KeyError(f"审批单不存在: {approval_id}")
            d = data[approval_id]
            if d["status"] != "pending":
                raise ValueError(f"审批单已处理: {d['status']}")
            d["status"] = "approved" if approve else "rejected"
            d["decided_at"] = datetime.now(timezone.utc).isoformat()
            d["decided_by"] = by
            d["decision_note"] = note
            self._save(data)
            return Approval.from_dict(d)

    def get(self, approval_id: str) -> Approval:
        data = self._load()
        if approval_id not in data:
            raise KeyError(f"审批单不存在: {approval_id}")
        return Approval.from_dict(data[approval_id])

    def find_for(self, session_id: str, tool: str, args: dict[str, Any]) -> Approval | None:
        """查找同会话、同工具、同参数的既往决定（支持审批后重放）。"""
        for d in self._load().values():
            if d["session_id"] == session_id and d["tool"] == tool and d["args"] == args:
                return Approval.from_dict(d)
        return None

    def list(self, *, status: str | None = None, session_id: str | None = None) -> list[Approval]:
        out = [Approval.from_dict(d) for d in self._load().values()]
        if status:
            out = [a for a in out if a.status == status]
        if session_id:
            out = [a for a in out if a.session_id == session_id]
        return sorted(out, key=lambda a: a.created_at, reverse=True)

    def pending_count(self) -> int:
        return len(self.list(status="pending"))
