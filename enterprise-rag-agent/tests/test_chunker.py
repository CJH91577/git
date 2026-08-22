"""切块器测试。"""

from aegis.ingestion.chunker import chunk_segment, split_text
from aegis.ingestion.parsers import RawSegment


def test_short_text_returns_single_piece():
    assert split_text("短文本", chunk_size=100) == ["短文本"]


def test_long_text_splits_into_pieces():
    text = "第一句话很长。" * 60
    pieces = split_text(text, chunk_size=200, overlap=40)
    assert len(pieces) >= 3
    assert all(len(p) <= 200 for p in pieces)


def test_overlap_keeps_context():
    text = "。".join(f"句子编号{i}内容填充文字" for i in range(30))
    pieces = split_text(text, chunk_size=150, overlap=30)
    for prev, cur in zip(pieces, pieces[1:]):
        # 重叠：前一段末尾部分应出现在后一段开头（允许因分隔符变化有小差异）
        assert prev[-15:] in cur or prev[-15:].rstrip("。") in cur


def test_chunk_segment_carries_metadata():
    seg = RawSegment(text="A。B。C。", metadata={"source": "t.txt", "page": 2})
    chunks = chunk_segment(seg, chunk_size=50, overlap=10)
    assert chunks
    for i, c in enumerate(chunks):
        assert c.metadata["source"] == "t.txt"
        assert c.metadata["page"] == 2
        assert c.metadata["chunk_index"] == i


def test_empty_text():
    assert split_text("   ", chunk_size=100) == []
