"""HITL 审批管理器测试（三种模式）。"""

import pytest

from aegis.config import get_settings
from aegis.hitl import ApprovalManager
from aegis.mcp.client import PendingToolCall


def _pending() -> PendingToolCall:
    return PendingToolCall(
        tool="send_email",
        args={"to": "a@b.com", "subject": "s", "body": "b"},
        agent="retriever",
        reason="敏感操作",
    )


def test_interactive_mode_pending(aegis_env):
    mgr = ApprovalManager()
    ap = mgr.create("ses_1", _pending())
    assert ap.status == "pending"
    assert mgr.pending_count() == 1


def test_decide_approve_reject(aegis_env):
    mgr = ApprovalManager()
    ap = mgr.create("ses_1", _pending())
    ap = mgr.decide(ap.approval_id, True, note="OK")
    assert ap.status == "approved"
    ap2 = mgr.create("ses_2", _pending())
    ap2 = mgr.decide(ap2.approval_id, False)
    assert ap2.status == "rejected"
    # 重复决定 → 报错
    with pytest.raises(ValueError):
        mgr.decide(ap.approval_id, False)


def test_auto_approve_mode(aegis_env, monkeypatch):
    monkeypatch.setenv("AEGIS_HITL_MODE", "auto_approve")
    from aegis.config import reset_settings

    reset_settings()
    mgr = ApprovalManager()
    ap = mgr.create("ses_1", _pending())
    assert ap.status == "approved"
    reset_settings()


def test_auto_deny_mode(aegis_env, monkeypatch):
    monkeypatch.setenv("AEGIS_HITL_MODE", "auto_deny")
    from aegis.config import reset_settings

    reset_settings()
    mgr = ApprovalManager()
    ap = mgr.create("ses_1", _pending())
    assert ap.status == "rejected"
    reset_settings()


def test_find_for_replay(aegis_env):
    mgr = ApprovalManager()
    p = _pending()
    ap = mgr.create("ses_9", p)
    mgr.decide(ap.approval_id, True)
    found = mgr.find_for("ses_9", p.tool, p.args)
    assert found is not None and found.status == "approved"


def test_persistence(aegis_env):
    mgr = ApprovalManager()
    mgr.create("ses_1", _pending())
    mgr2 = ApprovalManager()
    assert mgr2.pending_count() == 1
