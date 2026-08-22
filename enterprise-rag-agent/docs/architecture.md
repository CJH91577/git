# 架构设计

## 1. 总体架构

Aegis 由五个核心子系统组成：

```
┌────────────────────────────────────────────────────────────────┐
│                       接入层（CLI / FastAPI / MCP 外部客户端）      │
├────────────────────────────────────────────────────────────────┤
│  Orchestrator 编排层                                            │
│   ├─ SessionStore（会话状态机持久化）                             │
│   └─ 多智能体流水线（见 §2）                                      │
├──────────────────┬──────────────────┬──────────────────────────┤
│ RAG 子系统        │ MCP 子系统        │ HITL 子系统               │
│ · 5 格式解析       │ · 工具服务器       │ · 审批单管理               │
│ · 递归切块         │ · 安全策略（白名单） │ · 三模式（交互/放行/拒绝）  │
│ · 向量+BM25 混合   │ · 双传输（内存/stdio）│ · 挂起→审批→恢复          │
├──────────────────┴──────────────────┴──────────────────────────┤
│ 基础设施：Chroma 向量库 · JSON 持久化 · LLM/Embedding 抽象层       │
└────────────────────────────────────────────────────────────────┘
```

## 2. 多智能体协作协议

每个问题按状态机执行，状态间通过结构化数据（而非自由文本）传递：

| 状态 | 智能体 | 输入 | 输出 |
|---|---|---|---|
| `planning` | **Planner** | 问题 + MCP 工具目录 | JSON 计划：`needs_retrieval` / `sub_questions[]` / `tools_to_call[]` |
| `retrieving` | **Retriever** | 计划 + 审计反馈 | 证据集（去重、带来源与位置）+ 工具结果 |
| `answering` | **Answerer** | 问题 + 证据 + 工具结果 + 审计反馈 | 草稿答案（句级引用 `[C1][C2]`） |
| `auditing` | **Auditor** | 问题 + 草稿 + 证据 | 审计报告：`verdict(pass/revise)` + 逐条声明核查 + `missing_topics` |

**自我修正循环**：Auditor 判 `revise` 时，`missing_topics` 作为新检索主题注入下一轮，
`feedback` 作为修订指令注入 Answerer；最多循环 `AEGIS_MAX_AUDIT_ROUNDS`（默认 3）轮。
超限仍不通过时，终答附加强警告；若审计判定「证据不足/相关性不足」，
**终答直接改为如实告知无法回答**——宁可拒答，不可编造。

**设计取舍**：以「状态机 + 结构化 JSON 传递」替代常见的「自由对话多轮聊天」，
使得每一跳都可观测、可审计、可单测（任何状态都可从磁盘恢复）。

## 3. RAG 子系统

- **解析**：PDF(pypdf) / DOCX(python-docx，含表格) / XLSX(openpyxl，按工作表) /
  PPTX(python-pptx，按幻灯片) / TXT·MD·CSV。每个片段携带 `source/page/sheet/slide` 元数据。
- **切块**：递归字符切分器，按段落→句子→标点优先级切分，600 字符 + 80 重叠（可配置）。
- **嵌入**：默认本地 `fastembed` + `bge-small-zh-v1.5`（ONNX，免 Key，检索侧加 bge 指令前缀）；
  可切换 OpenAI 兼容 API 或 Ollama。
- **存储**：Chroma 持久化（cosine 空间），按 `doc_id` 组织，支持整文档删除。
- **检索**：向量 top-k 与 BM25 top-k（jieba 分词）做 **RRF 融合**——语义召回与
  精确术语（型号、编号、数字）互补。
- **入库幂等**：文件 SHA-256 作为 doc_id，重复入库自动覆盖旧版本。

## 4. MCP 子系统与安全模型

工具服务器基于官方 `mcp` Python SDK（`FastMCP`），工具参数由 MCP 协议
的 JSON Schema 强校验。运行时通过标准 `ClientSession` 连接，支持：

- **in-process**：内存通道，零开销（默认，适合嵌入式部署）；
- **stdio**：独立子进程 + 标准 MCP stdio 协议（`python -m aegis.mcp.server`），
  与 Claude Desktop / Cursor 等外部 MCP 客户端互通。

安全隔离为**两道独立防线**：

1. **最小权限白名单**（`aegis/mcp/policy.py`）：每个智能体只能调用其职责内工具。
   例如 Answerer/Planner 的工具白名单为空——任何越权调用在策略层直接拒绝，
   根本到不了工具实现。
2. **敏感操作 HITL**（`SENSITIVE_TOOLS`）：发邮件 / 导出 / 删除等对外产生影响的操作，
   即使白名单放行，也**必须**先产生审批单并挂起，人工 approve 后才真正执行。

工具实现层面同样防御：`calculator` 用 AST 白名单求值（拒绝导入/调用/属性访问），
`export_file` 强制写入沙箱目录并净化文件名。

## 5. HITL 子系统

- **审批单**：`{approval_id, session_id, tool, args, agent, reason, status}`，
  JSON 持久化，全链路可追溯。
- **三种模式**（`AEGIS_HITL_MODE`）：
  - `interactive`：挂起等待人工 `approve/reject`（默认）；
  - `auto_approve`：自动放行（仅受信任环境）；
  - `auto_deny`：自动拒绝（fail-safe 默认拒绝）。
- **挂起与恢复**：敏感调用将编排器状态机挂起为 `awaiting_approval`（记录
  `resume_state`）；`resume` 时按 `(session, tool, args)` 重放审批决定——
  已批准的执行、已拒绝的跳过，无需重复人工操作。
- 会话与审批均落盘，服务重启后可继续处理。

## 6. 关键设计决策记录

| 决策 | 理由 |
|---|---|
| 状态机而非自由聊天循环 | 可观测、可恢复、可单测；避免无限 token 消耗 |
| 结构化 JSON 作为智能体间协议 | 与 MCP/工具 Schema 一致，便于校验与审计 |
| 嵌入默认本地模型 | 企业数据不出内网；零 Key 快速启动 |
| LLM 后端离线兜底 | CI 与演示可复现；真实环境零成本切换 |
| RRF 而非单一路径 | 中文语义 + 精确术语检索质量显著优于单向量 |
