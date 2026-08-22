"""递归字符切分器：优先按段落/句子边界切分，支持重叠窗口，适合中英文。"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from aegis.ingestion.parsers import RawSegment

# 分隔符优先级：从粗到细
_SEPARATORS = ["\n\n", "\n", "。", "！", "？", "；", ". ", "! ", "? ", "; ", "，", ", ", " "]


@dataclass
class Chunk:
    text: str
    metadata: dict = field(default_factory=dict)


def split_text(text: str, chunk_size: int = 600, overlap: int = 80) -> list[str]:
    """把长文本递归切分为不超过 chunk_size 字符的片段。"""
    text = text.strip()
    if not text:
        return []
    if len(text) <= chunk_size:
        return [text]

    pieces: list[str] = []

    def rec(block: str) -> None:
        if len(block) <= chunk_size:
            if block.strip():
                pieces.append(block.strip())
            return
        # 找到最靠后的可用分割点
        cut = -1
        sep_used = ""
        for sep in _SEPARATORS:
            pos = block.rfind(sep, 0, chunk_size)
            if pos > chunk_size * 0.4:  # 分割点不能太靠前，否则碎片化
                cut, sep_used = pos, sep
                break
        if cut == -1:  # 没有合适分割点：硬切
            cut = chunk_size
            sep_used = ""
        head = block[: cut + len(sep_used)].strip()
        rest = block[cut + len(sep_used):].strip()
        if head:
            pieces.append(head)
        # 重叠：保留上一段尾部 overlap 字符
        if len(head) > overlap:
            rest = head[-overlap:] + " " + rest
        if rest and rest != block:
            rec(rest)
        elif rest:  # 防死循环
            pieces.append(rest)

    rec(text)
    return [p for p in pieces if len(p.strip()) >= 1]


def chunk_segment(seg: RawSegment, chunk_size: int = 600, overlap: int = 80) -> list[Chunk]:
    """把一个原始解析片段切为 Chunk 列表，继承来源元数据。"""
    out: list[Chunk] = []
    for i, piece in enumerate(split_text(seg.text, chunk_size, overlap)):
        meta = dict(seg.metadata)
        meta["chunk_index"] = i
        out.append(Chunk(text=piece, metadata=meta))
    return out
