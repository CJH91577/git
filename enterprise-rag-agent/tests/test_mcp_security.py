"""MCP 安全策略 + 安全计算器测试。"""

import pytest

from aegis.mcp.policy import ToolSecurityPolicy, is_sensitive
from aegis.mcp.server import _safe_eval


def test_safe_eval_basic():
    assert _safe_eval("12*8+6") == 102
    assert _safe_eval("(1000-700)*0.13") == pytest.approx(39.0)
    assert _safe_eval("2^10") == 1024
    assert _safe_eval("sqrt(16)+2") == 6


def test_safe_eval_rejects_injection():
    for expr in [
        "__import__('os').system('dir')",
        "open('/etc/passwd').read()",
        "1; print('x')",
        "eval('1+1')",
        "lambda: 1",
        "1 and 2",
    ]:
        with pytest.raises(ValueError):
            _safe_eval(expr)


def test_safe_eval_division_by_zero():
    with pytest.raises(ZeroDivisionError):
        _safe_eval("1/0")


def test_policy_allowlist():
    policy = ToolSecurityPolicy()
    # retriever 可调用常规工具
    d = policy.check("calculator", "retriever")
    assert d.ok and not d.requires_approval
    # answerer/planner 无权调用
    d = policy.check("calculator", "answerer")
    assert not d.ok and "无权" in d.reason
    d = policy.check("calculator", "planner")
    assert not d.ok
    # 未知角色
    assert not policy.check("calculator", "hacker").ok


def test_policy_sensitive_requires_approval():
    policy = ToolSecurityPolicy()
    d = policy.check("send_email", "retriever")
    assert d.ok and d.requires_approval
    assert is_sensitive("send_email")
    assert not is_sensitive("calculator")
