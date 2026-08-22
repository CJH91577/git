# 🛡️ Aegis —— 企业级 AI 智能体平台

> 多格式文档 RAG · 多智能体协作 · MCP 工具调用 · 事实核查自修正 · HITL 人工审批

**Aegis**（/ˈiːdʒɪs/，神盾）是一个开箱即用的企业级 AI 智能体应用，
围绕「**可信回答**」与「**安全执行**」两条主线设计：

- 回答侧：多智能体（Planner → Retriever → Auditor → Answerer）分工协作，
  每个答案都要经过 **Auditor 事实核查**，证据不足时**如实说明、绝不编造**；
- 执行侧：工具调用基于 **MCP（Model Context Protocol）** 标准化协议，
  配合**最小权限白名单 + 敏感操作人工审批（HITL）**实现安全隔离。

```
                    ┌──────────────────────────────────────────────┐
                    │                用户 / FastAPI / CLI            │
                    └──────────────────────┬───────────────────────┘
                                           │ 提问
                    ┌──────────────────────▼───────────────────────┐
                    │           Orchestrator（多智能体编排器）        │
                    │                                              │
                    │  ① Planner    规划：拆解子问题 + 工具计划        │
                    │  ② Retriever  检索：混合检索 + MCP 工具执行      │
                    │  ③ Answerer   起草：基于证据、带引用 [C1][C2]   │
                    │  ④ Auditor    核查：逐条声明 vs 证据            │
                    │       └─ revise ─► 带反馈重检/重答（≤3 轮）     │
                    └──────┬──────────────────────────────┬────────┘
                           │ 语义检索                       │ MCP 协议
              ┌────────────▼───────────┐       ┌───────────▼────────────┐
              │  知识库（RAG）           │       │   MCP 工具服务器        │
              │  PDF/DOCX/XLSX/PPTX/TXT│       │  calculator / kb_search │
              │  → 解析 → 切块 → 向量化  │       │  doc_stats / …          │
              │  → Chroma + BM25 混合   │       │  🔒 敏感工具 → HITL 审批 │
              └────────────────────────┘       └────────────────────────┘
```

## ✨ 核心能力

| 需求 | 实现 |
|---|---|
| 多格式文档知识入库与语义检索 | PDF / Word / Excel / PPT / TXT 解析（含表格、幻灯片、页码定位）；递归切块；**向量 + BM25 混合检索（RRF 融合）**；本地嵌入免 API Key |
| 多智能体分工协作 | **Planner**（规划）→ **Retriever**（检索+工具）→ **Answerer**（带引用起草）→ **Auditor**（核查），审计不通过自动带反馈重新检索/作答，最多 N 轮 |
| 基于 MCP 的工具调用标准化与安全隔离 | 基于官方 `mcp` SDK 实现 MCP 服务器（支持 in-process 与标准 **stdio** 两种接入）；JSON Schema 参数校验；**按智能体最小权限白名单**；AST 白名单计算器杜绝注入 |
| Auditor 事实核查与自我修正 | 逐条核对声明 vs 证据（supported/unsupported/contradicted），输出可信度评分与修订意见；证据不足时**明确告知、拒绝编造**，可自主补充检索 |
| HITL 人工干预 | 敏感工具（发邮件/导出/删除）触发**审批单挂起**，支持 approve/reject 后恢复执行；三种模式：`interactive` / `auto_approve` / `auto_deny`（默认拒绝，fail-safe） |

## 🚀 快速开始

```bash
# 1. 安装（Python 3.10+）
cd enterprise-rag-agent
pip install -e .

# 2.（可选）配置 LLM —— 默认离线模式无需配置；接入真实模型见下文
cp .env.example .env   # 填入 OPENAI 兼容的 API Key（OpenAI/DeepSeek/Ollama 等）

# 3. 一键端到端演示（自动生成 5 种格式样例文档 → 入库 → 问答 → 审批，全部自校验）
aegis demo

# 4. 导入你自己的文档
aegis ingest ./your_docs

# 5. 提问（多智能体流水线）
aegis ask "一线城市出差住宿报销上限是多少？"

# 6. 启动 HTTP 服务（Swagger: http://127.0.0.1:8000/docs）
aegis serve
```

**无需任何 API Key 即可跑通全流程**：默认嵌入模型用本地 ONNX
（`BAAI/bge-small-zh-v1.5`，首次自动下载约 95MB），LLM 用内置确定性
后端完成端到端验证；接入真实模型只需在 `.env` 中配置。

### 接入真实 LLM

支持任意 **OpenAI 兼容协议**端点：

```bash
# OpenAI / DeepSeek / 通义 / 本地 vLLM
AEGIS_LLM_PROVIDER=openai
AEGIS_LLM_BASE_URL=https://api.deepseek.com/v1
AEGIS_LLM_API_KEY=sk-xxxx
AEGIS_LLM_MODEL=deepseek-chat

# 或本地 Ollama（含嵌入，完全离线）
AEGIS_LLM_PROVIDER=ollama
AEGIS_LLM_MODEL=qwen2.5:3b
AEGIS_EMBED_PROVIDER=ollama
AEGIS_EMBED_MODEL=nomic-embed-text
```

## 📖 使用文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 架构设计、多智能体协作协议、安全模型 |
| [docs/deploy.md](docs/deploy.md) | 部署、配置、LLM 接入、MCP stdio 模式 |
| [docs/verification.md](docs/verification.md) | 端到端自验证报告与验证方法 |

## 🔌 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/documents/ingest` | 上传文档入库（multipart） |
| POST | `/api/documents/ingest-path` | 按路径批量入库 |
| GET | `/api/documents` | 文档列表 |
| DELETE | `/api/documents/{id}` | 删除文档（**敏感 → HITL**） |
| POST | `/api/chat` | 提问（多智能体流水线） |
| GET | `/api/sessions/{id}` | 会话状态 |
| POST | `/api/sessions/{id}/resume` | 审批后恢复会话 |
| GET | `/api/approvals` | 审批单列表 |
| POST | `/api/approvals/{id}/decide` | 批准/拒绝（`{"approve": true}`） |
| GET | `/api/tools` · POST `/api/tools/call` | MCP 工具目录 / 人工调用工具 |
| GET | `/health` | 健康检查 |

## 🧩 MCP 工具

以标准 **Model Context Protocol** 暴露，可被任何 MCP 客户端接入：

```bash
python -m aegis.mcp.server   # 标准 stdio 服务
```

| 工具 | 说明 | 安全等级 |
|---|---|---|
| `calculator` | AST 白名单安全计算 | ✅ 常规 |
| `get_current_time` | 当前时间 | ✅ 常规 |
| `kb_search` | 知识库语义检索 | ✅ 常规 |
| `doc_stats` | 知识库统计 | ✅ 常规 |
| `send_email` | 模拟发邮件 | 🔒 **敏感 → HITL** |
| `export_file` | 导出文件（沙箱目录） | 🔒 **敏感 → HITL** |
| `delete_document` | 删除文档 | 🔒 **敏感 → HITL** |

## 🧪 测试与验证

```bash
pip install -e ".[dev]"
pytest -q              # 单元 + 集成测试（全部离线可跑）
aegis demo             # 端到端演示（含 20+ 条自校验断言）
```

## 📁 目录结构

```
enterprise-rag-agent/
├── aegis/
│   ├── llm/            # LLM 抽象层（OpenAI 兼容 / Ollama / 离线确定性）
│   ├── embeddings/     # 嵌入层（fastembed 本地 / OpenAI / Ollama）
│   ├── ingestion/      # 解析（5 格式）→ 切块 → 入库管道
│   ├── retrieval/      # Chroma 向量库 + BM25 混合检索
│   ├── mcp/            # MCP 服务器 / 客户端 / 安全策略
│   ├── agents/         # Planner / Retriever / Answerer / Auditor
│   ├── hitl/           # 人工审批管理器
│   ├── api/            # FastAPI 服务
│   ├── orchestrator.py # 多智能体编排器（状态机 + 挂起恢复）
│   ├── demo.py         # 端到端演示
│   └── cli.py          # 命令行入口
├── scripts/make_sample_docs.py   # 样例文档生成
├── tests/              # pytest 套件
└── docs/               # 架构 / 部署 / 验证文档
```

## ⚠️ 安全说明

- 敏感工具**默认拒绝**（`auto_deny`），生产环境建议保持 `interactive` 人工审批；
- `export_file` 仅允许写入数据目录下的 `exports/` 沙箱；
- 计算器采用 AST 白名单求值，不存在 `eval` 注入面；
- 该项目的 `send_email` 为**模拟实现**，接入真实邮件网关前请自行实现并保持 HITL 审批。

## 📄 License

[MIT](./LICENSE)
