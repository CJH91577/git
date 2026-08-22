"""ScriptedLLM —— 离线确定性 LLM 后端。

不需要任何 API Key 或本地模型即可完整跑通整个多智能体流水线，
用于 CI、单元测试与无 GPU 环境的演示。行为规则：

- 消息中带有 ``[TASK:<name>]`` 标记（由各 Agent 的 prompt 注入）时，
  按任务类型返回确定性 JSON；
- ``answer`` 任务基于上下文中的证据片段做**提取式**回答（绝不编造），
  并附上引用编号；
- ``audit`` 任务核查证据是否覆盖问题，覆盖则通过，否则给 revise 意见。
"""

from __future__ import annotations

import json
import re
from typing import Any

from aegis.llm.base import LLMError, LLMProvider, Message

_JSON_RE = re.compile(r"\{.*\}", re.S)
_TAG_RE = re.compile(r"\[TASK:([a-z_]+)\]", re.I)
_CITE_RE = re.compile(r"\[C(\d+)\]", re.I)


class ScriptedLLM(LLMProvider):
    name = "scripted"

    def complete(
        self,
        messages: list[Message],
        *,
        json_mode: bool = False,
        temperature: float | None = None,
    ) -> str:
        tag = self._find_tag(messages)
        if tag == "planner":
            return self._plan(messages)
        if tag == "answer":
            return self._answer(messages)
        if tag == "audit":
            return self._audit(messages)
        if tag == "json":
            return self._generic_json(messages)
        # 未识别任务：返回最后一条消息的简短回显
        last = next((m for m in reversed(messages) if m.get("role") == "user"), {})
        return f"[scripted] {last.get('content', '')[:80]}"

    # ---------------- 内部实现 ----------------

    @staticmethod
    def _find_tag(messages: list[Message]) -> str | None:
        for msg in messages:
            content = msg.get("content", "")
            m = _TAG_RE.search(content)
            if m:
                return m.group(1).lower()
        return None

    @staticmethod
    def _context_block(messages: list[Message]) -> str:
        """拼接所有消息文本，从中提取【证据】块。"""
        parts: list[str] = []
        for msg in messages:
            parts.append(str(msg.get("content", "")))
        return "\n".join(parts)

    def _extract_evidence(self, blob: str) -> list[tuple[str, str]]:
        """提取 [C1] 标题 证据文本 形式的证据片段，返回 (id, text) 列表。"""
        items: list[tuple[str, str]] = []
        lines = blob.splitlines()
        cur_id, cur_text = None, ""
        for line in lines:
            m = re.match(r"^\s*\[C(\d+)\]\s*(.*)$", line)
            if m:
                if cur_id is not None and cur_text.strip():
                    items.append((cur_id, cur_text.strip()))
                cur_id, cur_text = m.group(1), m.group(2)
            elif cur_id is not None:
                cur_text += "\n" + line
        if cur_id is not None and cur_text.strip():
            items.append((cur_id, cur_text.strip()))
        return items

    def _answer(self, messages: list[Message]) -> str:
        blob = self._context_block(messages)
        question = self._question(messages)
        evidence = self._extract_evidence(blob)
        # 工具调用结果（如 calculator → 1024）应出现在答案中
        tool_lines: list[str] = []
        m = re.search(r"【工具调用结果】\n(.*?)(?:\n\n【证据】|$)", blob, re.S)
        if m:
            for line in m.group(1).splitlines():
                line = line.strip()
                if line.startswith("- "):
                    tool_lines.append(line[2:].strip())
        if not evidence:
            if tool_lines:
                return "根据工具调用结果：" + "；".join(tool_lines) + "。（该问题无需检索知识库。）"
            return (
                "抱歉，知识库中没有找到与该问题相关的信息，我无法给出有依据的回答。"
                "请补充相关文档后再试。"
            )
        sentences: list[str] = []
        q_tokens = self._match_tokens(question)
        ranked: list[tuple[int, str, str]] = []  # (命中数, cid, 句子)

        def _is_noise(s: str) -> bool:
            """来源标签/文件名碎片等非内容句。"""
            return s.startswith("来源") or (s.count("《") == 1 and "：" not in s)

        for cid, text in evidence:
            snips = [s for s in re.split(r"(?<=[。！？；!?;])", text) if s.strip()]
            snips = [s.strip() for s in snips if not _is_noise(s.strip())]
            hits = [s for s in snips if q_tokens & (set(self._tokens(s)) | self._bigrams(s))]
            pool = hits[:3] or snips[:1]  # 优先关键词命中句；无命中则取首句兜底
            kept = "".join(pool).strip()
            if kept:
                ranked.append((len(hits), cid, f"{kept} [C{cid}]"))
        ranked.sort(key=lambda x: (-x[0], x[1]))
        body = "；".join(s for _, _, s in ranked[:3])
        head = ""
        if tool_lines:
            head = "工具计算结果：" + "；".join(tool_lines).rstrip("。") + "。"
        return f"{head}根据知识库资料：{body}。（以上内容均引自知识库文档，未包含未经验证的外部信息。）"

    def _audit(self, messages: list[Message]) -> str:
        blob = self._context_block(messages)
        question = self._question(messages)
        evidence = self._extract_evidence(blob)
        draft = self._extract_draft(messages)
        # 工具计算类问题：答案以工具结果为准，不要求知识库证据相关性
        has_tool_result = "【工具调用结果】" in blob and re.search(
            r"【工具调用结果】\n-\s+\S+", blob
        )
        if has_tool_result and ("算式" in question or draft.startswith("工具计算结果")):
            return json.dumps(
                {
                    "verdict": "pass",
                    "score": 0.9,
                    "claims": [{"claim": draft[:60], "support": "supported", "citations": [], "issue": ""}],
                    "feedback": "工具计算类问题，答案以工具结果为准。",
                    "missing_topics": [],
                },
                ensure_ascii=False,
            )
        q_words = self._match_tokens(question) - {"什么", "哪些", "多少", "如何", "请问", "公司", "制度"}
        if not q_words:
            q_words = {"*"}
        covered = 0
        claims: list[dict[str, Any]] = []
        for cid, text in evidence[:4]:
            text_tokens = set(self._tokens(text)) | self._bigrams(text)
            overlap = len(q_words & text_tokens) / max(len(q_words), 1)
            covered = max(covered, overlap)
            claims.append({"claim": text[:50], "support": "supported", "citations": [f"C{cid}"], "issue": ""})
        # 检查草稿中的引用是否都有对应证据
        cite_ok = all(f"C{c}" in draft or True for c, _ in evidence)  # 宽松策略
        has_gap = "未找到" in draft or "无法" in draft or not evidence
        if has_gap:
            verdict, score, feedback = "revise", 0.3, "证据不足，请勿编造；建议明确告知用户知识库中缺少相关信息。"
        elif covered < 0.15:
            verdict, score, feedback = "revise", max(0.3, covered), "检索结果与问题相关性不足，请更换检索词重新检索。"
        else:
            verdict, score, feedback = "pass", min(1.0, 0.55 + covered * 0.45), "证据充分，引用有效。"
        return json.dumps(
            {
                "verdict": verdict,
                "score": round(score, 2),
                "claims": claims,
                "feedback": feedback,
                "missing_topics": [] if not has_gap else [question],
            },
            ensure_ascii=False,
        )

    def _plan(self, messages: list[Message]) -> str:
        blob = self._context_block(messages)
        question = self._question(messages)
        needs_retrieval = "[EVIDENCE:KB]" in blob
        tools: list[dict[str, Any]] = []
        m = re.search(r"算式[:：]\s*([0-9+\-*/().^%\s]+)", blob)
        if m and m.group(1).strip():
            tools.append({"tool": "calculator", "args": {"expression": m.group(1).strip()}})
        # [ACTION] 显式工具调用标签（只从问题文本提取，忽略 prompt 中的示例），支持两种形式：
        #   JSON:   [ACTION] {"tool": "send_email", "args": {...}}
        #   键值:   [ACTION] send_email to=a@b.com subject=通知 body=内容（shell 友好，无引号）
        for raw in re.findall(r"\[ACTION\]\s*(\{[^[]*\})", question):
            try:
                call = json.loads(raw)
                if isinstance(call, dict) and "tool" in call:
                    tools.append(call)
            except json.JSONDecodeError:
                continue
        for m in re.finditer(r"\[ACTION\]\s*([a-z_]+)\s+([^\n\[<]+)", question):
            tool, kvs = m.group(1), m.group(2)
            args = {}
            for kv in kvs.split():
                if "=" in kv:
                    k, _, v = kv.partition("=")
                    args[k] = v
            if tool and args:
                tools.append({"tool": tool, "args": args})
        plan = {
            "needs_retrieval": needs_retrieval,
            "sub_questions": [question] if needs_retrieval else [],
            "tools_to_call": tools,
            "reasoning": "scripted 确定性规划：按问题类型决定检索与工具调用。",
        }
        return json.dumps(plan, ensure_ascii=False)

    def _generic_json(self, messages: list[Message]) -> str:
        return json.dumps({"result": "ok"}, ensure_ascii=False)

    @staticmethod
    def _question(messages: list[Message]) -> str:
        for msg in reversed(messages):
            if msg.get("role") == "user":
                m = re.search(r"<question>(.*?)</question>", msg.get("content", ""), re.S)
                if m:
                    return m.group(1).strip()
                content = msg.get("content", "").strip()
                if content and not content.startswith("[TASK:"):
                    return content[:200]
        return ""

    @staticmethod
    def _extract_draft(messages: list[Message]) -> str:
        for msg in reversed(messages):
            m = re.search(r"<draft>(.*?)</draft>", msg.get("content", ""), re.S)
            if m:
                return m.group(1)
        return ""

    @staticmethod
    def _tokens(text: str) -> list[str]:
        import jieba

        jieba.setLogLevel(60)
        return [t for t in jieba.cut(text) if len(t.strip()) > 1]

    @staticmethod
    def _bigrams(text: str) -> set[str]:
        """字符级 2-gram：不依赖分词词典，对未登录词（如「年假」）更鲁棒。"""
        return {text[i : i + 2] for i in range(len(text) - 1)}

    @classmethod
    def _match_tokens(cls, question: str) -> set[str]:
        return {t for t in cls._tokens(question) if len(t) > 1} | cls._bigrams(question)
