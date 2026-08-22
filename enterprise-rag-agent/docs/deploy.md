# 部署与配置

## 环境要求

- Python 3.10+（Windows / Linux / macOS）
- 首次运行需联网下载嵌入模型（约 95MB，缓存于本地）
- 可选：Ollama（完全离线 LLM）或任意 OpenAI 兼容 API

## 安装

```bash
cd enterprise-rag-agent
python -m venv .venv
# Windows: .venv\Scripts\activate   Linux/macOS: source .venv/bin/activate
pip install -e .
```

## 配置（.env，前缀 AEGIS_）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AEGIS_LLM_PROVIDER` | `openai` | `openai`（任意兼容端点）/ `ollama` / `scripted`（离线） |
| `AEGIS_LLM_BASE_URL` | — | 兼容端点地址（如 `https://api.deepseek.com/v1`） |
| `AEGIS_LLM_API_KEY` | — | API Key |
| `AEGIS_LLM_MODEL` | `gpt-4o-mini` | 模型名 |
| `AEGIS_EMBED_PROVIDER` | `fastembed` | `fastembed`（本地）/ `openai` / `ollama` |
| `AEGIS_EMBED_MODEL` | `BAAI/bge-small-zh-v1.5` | 嵌入模型 |
| `AEGIS_DATA_DIR` | `./data` | 数据目录（向量库/审批单/会话） |
| `AEGIS_RETRIEVAL_TOP_K` | 6 | 向量检索 top-k |
| `AEGIS_RERANK_TOP_K` | 4 | 融合后取前 k |
| `AEGIS_MAX_AUDIT_ROUNDS` | 3 | 审计自修正最大轮数 |
| `AEGIS_AUDITOR_SCORE_THRESHOLD` | 0.7 | 审计可信度阈值 |
| `AEGIS_HITL_MODE` | `interactive` | `interactive` / `auto_approve` / `auto_deny` |
| `AEGIS_MCP_TRANSPORT` | `inprocess` | `inprocess` / `stdio` |

## 启动服务

```bash
aegis serve --host 0.0.0.0 --port 8000
# Swagger 文档: http://127.0.0.1:8000/docs
```

生产建议置于反向代理后，并启用 HTTPS；敏感操作保持 `AEGIS_HITL_MODE=interactive`。

## MCP 外部接入

以标准 stdio 方式对外提供服务，可被 Claude Desktop 等客户端接入：

```json
// claude_desktop_config.json 示例
{
  "mcpServers": {
    "aegis-tools": {
      "command": "python",
      "args": ["-m", "aegis.mcp.server"],
      "cwd": "/path/to/enterprise-rag-agent"
    }
  }
}
```

## 离线部署（无外网 / 无 API Key）

1. 预先在有网机器上运行一次入库，使嵌入模型进入本地缓存；
2. `AEGIS_LLM_PROVIDER=ollama` + 内网 Ollama 服务（或 `scripted` 纯离线演示）；
3. 将 `data/`（含 Chroma）与模型缓存随应用发布。

## 常见问题

**Q: 首次运行报模型下载失败？**
设置 HuggingFace 镜像：`HF_ENDPOINT=https://hf-mirror.com`。

**Q: 想用通义/文心等非 OpenAI 协议模型？**
实现 `aegis.llm.base.LLMProvider` 接口即可（约 20 行），或使用其 OpenAI 兼容网关。

**Q: 如何扩展新文档格式？**
在 `aegis/ingestion/parsers.py` 增加解析函数并在 `parse_file` 注册，
同时在 `SUPPORTED_EXTS` 添加扩展名。

**Q: 如何接入真实邮件/审批系统？**
替换 `aegis/mcp/server.py` 中 `send_email` 的模拟实现；
审批单可通过 `ApprovalManager.list()` 导出，接入企业 OA 的流程只需在
`decide` 前增加通知钩子。
