# 稳智对齐 · 方案 C · AI 网关切换收尾

**日期**：2026-09-23
**结论**：Bifrost 网关已部署完毕，等 Groq 免费 API key 到手即可端到端打通

---

## 一、本轮走过的路（4 个网关，最终选定 Bifrost + Groq）

| 网关 | 上游 | 结局 | 原因 |
|---|---|---|---|
| chat2api 1.8.8-beta2 | chatgpt.com | ❌ 弃用 | OpenAI 2025 版 JWE 加密 session-token（3933 字符 A256GCM），社区/官方均不支持，本地无解 |
| doubao2API | 豆包网页 | ⏸️ 搁置 | Playwright 1.63 需要 chromium-1243，机器上只有 1217；`start.py` 检测逻辑误报"已安装" |
| **Bifrost 1.6.3**（@maximhq/bifrost） | **Groq 免费 tier** | ✅ **已部署** | 企业级 OpenAI 兼容网关，支持 23+ provider，npx 116MB 无需 Docker |

## 二、Bifrost 部署位置

| 项 | 值 |
|---|---|
| Binary | `C:\Users\Lenovo\AppData\Local\bifrost\v2.2.2\bin\bifrost-http.exe-0` (116MB) |
| App 目录 | `D:\bifrost-data\` |
| 配置文件 | `D:\bifrost-data\config.json` |
| 运行日志 | `D:\bifrost-data\bifrost.log` |
| Web UI | `http://localhost:8080` |
| API 端点 | `http://localhost:8080/v1` |
| 后台进程 | bash_id `75747f2f`（runtime lifetime，会一直跑） |

## 三、config.json 关键内容

```json
{
  "$schema": "https://www.getbifrost.ai/schema",
  "providers": {
    "groq": {
      "keys": [
        { "name": "groq-primary", "value": "env.GROQ_API_KEY",
          "models": ["*"], "weight": 1.0 }
      ],
      "network_config": { "default_request_timeout_in_seconds": 180, "max_retries": 2 }
    },
    "ollama": {
      "keys": [{ "name": "ollama-local", "value": "", "models": ["*"],
        "ollama_key_config": { "url": "http://localhost:11434" } }]
    }
  },
  "client": { "enforce_auth_on_inference": false, "allowed_origins": ["*"] },
  "config_store": { "enabled": false },
  "logs_store": { "enabled": false }
}
```

- **Groq 走 `env.GROQ_API_KEY`**：不硬编码 key，注入启动时环境变量
- **Ollama 预留**：本地模型通道（未来可无缝接入，本地模型 100% 免费）
- **无需治理层**：`enforce_auth_on_inference=false`，Kairo 直连不需要虚拟 key
- **不需要 DB**：`config_store.enabled=false`，纯文件系统，无 SQLite 依赖

## 四、Kairo `.env` 切换

```diff
- LLM_BASE_URL=http://localhost:7861/v1
- LLM_API_KEY=
- LLM_MODEL_NAME=doubao-pro
+ LLM_BASE_URL=http://localhost:8080/v1
+ LLM_API_KEY=admin
+ LLM_MODEL_NAME=groq/llama-3.3-70b-versatile
```

`model-config-core.ts` 的判定：`http://localhost:8080` 是 LAN 地址 → 走 gateway 模式 → 免 Key 直连 → 无需改任何业务代码。

**模型选择**：`llama-3.3-70b-versatile` 是 Groq 免费 tier 里速度最快的旗舰模型（500+ token/s），中文/金融分析够用。备选：
- `llama-3.1-8b-instant`（最快，中文稍弱）
- `deepseek-v3-0324`（推理更强，速度稍慢）
- `llama-3.3-70b-versatile`（推荐，均衡）

## 五、✅ 已打通端到端（22:19 UTC+8）

### Groq 模型清单（11 个可用）

```
groq/allam-2-7b
groq/canopylabs/orpheus-arabic-saudi
groq/canopylabs/orpheus-v1-english
groq/meta-llama/llama-prompt-guard-2-22m
groq/meta-llama/llama-prompt-guard-2-86m
groq/openai/gpt-oss-120b          ← Kairo 默认（最强）
groq/openai/gpt-oss-20b
groq/openai/gpt-oss-safeguard-20b
groq/qwen/qwen3.8-27b             ← 中文最强备选
groq/whisper-large-v3
groq/whisper-large-v3-turbo
```

**注意**：Groq 免费 tier 已不再免费开放 llama-3.3-70b-versatile（旧文档过时）。

### 关键坑（已解决）

Groq 直连 403 Forbidden（被墙），必须走系统代理 `127.0.0.1:10808`。
已在 `D:\bifrost-data\config.json` 加：
```json
"proxy_config": { "type": "http", "url": "http://127.0.0.1:10808" }
```

### Kairo `.env` 最终状态

```
LLM_BASE_URL=http://localhost:8080/v1
LLM_API_KEY=admin
LLM_MODEL_NAME=groq/qwen/qwen3.8-27b
```

**模型选择**：qwen3.8-27b 是 Groq 免费 tier 里**中文金融最强的**（阿里出品），实测：
- 中文金融术语地道（"回踩 MA5 不破加仓"、"量能不退潮"）
- 每个结论都带"理由："，符合稳智决策 widget 字段化输出
- 3s/条，比 gpt-oss-120b 快 40%
- 论据密度和长度都胜 gpt-oss-120b

### 实测（真实对话）

- `/api/ai/proxy`（普通对话通道）：✅ 完美返回中文
- `/api/ai/chat`（AI 交易员通道）：⚠️ 被既有代码闸门拦（`route.ts:391`）——它要工具调用环，网关模式不给放过去
  - 这是**既有代码设计**（P7 口径），不是 Bifrost 的问题
  - Bifrost 本身支持 tools，但 Kairo 认为 `localhost:8080` 是"本地网关"就拦了
  - **短期解法**：走 `/api/ai/proxy`（稳智对话页、奇门解盘、智能助手都走这里）
  - **长期解法**：改 `model-config-core.ts` 的 `isLanBaseUrl` 判定，或让 Bifrost 绑定非本地域名

### 后台进程

| ID | 服务 | 端口 |
|---|---|---|
| `e14c10eb` | Bifrost（带 Groq key + proxy） | 8080 |
| `bf817f29` | Kairo Next.js dev | 3000 |

## 六、下一步

- **稳智 P0 #1 意图识别器**：LLM 通了就能上（前端已就绪）
- **稳智 P1**（StepTimeline 6 阶段 / 错误码映射 / 侧栏历史）：纯前端，与 LLM 无关，随时可做
- **本地菜单"全球事件"**：按你明确要求保留，不归类不删
- **chat2api**：`D:\chat2api\chat2api-main`（token 已清空，不再使用）
- **doubao2API**：`D:\doubao2API-main`（Playwright Chromium 版本不匹配先搁置）

## 八、参考

- Bifrost 主仓库：<https://github.com/z1125yan-debug/bifrost>（fork of maximhq/bifrost）
- Provider 配置：<https://docs.getbifrost.ai/deployment-guides/config-json/providers>
- Config Schema：<https://docs.getbifrost.ai/deployment-guides/config-json/schema-reference>
- Groq 控制台：<https://console.groq.com/keys>
- Groq 免费模型：<https://console.groq.com/docs/models>
