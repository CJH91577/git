"""pytest 共享夹具：临时数据目录 + 环境隔离。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# 确保项目根在 sys.path（flat 布局）
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture()
def aegis_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """隔离的 AEGIS 环境：临时目录 + 离线 scripted LLM。"""
    data = tmp_path / "data"
    monkeypatch.setenv("AEGIS_DATA_DIR", str(data))
    monkeypatch.setenv("AEGIS_CHROMA_DIR", str(data / "chroma"))
    monkeypatch.setenv("AEGIS_UPLOAD_DIR", str(data / "uploads"))
    monkeypatch.setenv("AEGIS_LLM_PROVIDER", "scripted")
    monkeypatch.setenv("AEGIS_EMBED_PROVIDER", "fastembed")
    monkeypatch.setenv("AEGIS_HITL_MODE", "interactive")
    monkeypatch.setenv("AEGIS_MCP_TRANSPORT", "inprocess")
    monkeypatch.setenv("AEGIS_MAX_AUDIT_ROUNDS", "2")
    # HF 下载兼容性：禁用 xet 传输（镜像环境下易失败）
    monkeypatch.setenv("HF_HUB_DISABLE_XET", "1")
    monkeypatch.setenv("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    from aegis.config import reset_settings

    reset_settings()
    from aegis.config import get_settings

    s = get_settings()
    s.ensure_dirs()
    yield s
    reset_settings()


@pytest.fixture()
def sample_docs(tmp_path: Path, aegis_env) -> list[Path]:
    """在临时目录生成 5 个样例文档并返回路径。"""
    import runpy

    samples = tmp_path / "samples"
    samples.mkdir(exist_ok=True)
    script = ROOT / "scripts" / "make_sample_docs.py"
    old_argv = sys.argv
    sys.argv = [str(script), str(samples)]
    try:
        ns = runpy.run_path(str(script), run_name="__sample_docs__")
        ns["main"]()  # run_name 非 __main__，需显式调用入口
    finally:
        sys.argv = old_argv
    return sorted(samples.iterdir())
