# 微信 AI 投研助手 · 实施方案（企微自建应用 + cpolar）

> 状态：方案待拍板（用户确认后再开工）。选定通道 = 企业微信自建应用；公网回调 = cpolar/frpc 内网穿透。
> 关联：复用 R20a 已补活的「高风险」档（`sentiment.ts`）、R20b 正在写的见顶压力分（`top-pressure-core.ts`）、现有 AI 大脑（`/api/ai/chat`）。

## 0. 目标

把 kairotrend 本机的 AI 投研能力接到微信，做两件事：

1. **能对话**：在微信里问「今天 A 股为什么跌」「现在风险到第几档」「哪个板块在领跌」等，本地 AI 回答（复用现有 `/api/ai/chat` 大脑 + 证据链）。
2. **能主动提醒**：见顶预警（风险等级 ≥ 偏高 / 高风险）在收盘后自动推微信给你。
3. **能办事（对标用户给的截图效果，即微信里的「小陆」AI 助手）**：不只聊天，还能像截图那样「我看下本机有没有…」→ 真去查 → 回带行动结论的话。语音消息也能问。

用户已定：触发方式 = 「收盘后自动推 + 手动按钮」两者都要；通道 = 企微自建应用；回调 = 内网穿透。

## 1. 方案选型（已定）

| 维度 | 选择 | 理由 |
|---|---|---|
| 微信通道 | **企业微信自建应用** | 个人免费建、合规、**不封号**、对话 + 主动推送都支持 |
| 公网回调 | **cpolar / frpc 内网穿透** | 本机跑 AI，把回调 URL 暴露到公网 |
| 不采用 | 个人号协议(wechaty/itchat) | 官方打击、易封号、稳的协议多收费 |
| 不采用 | 公众号 | 个人拿不到认证，订阅号不能主动发消息 |
| 不采用 | 微信客服 | 主动推送受限（需用户近期互动），不适合预警强推 |

## 2. 你需准备的资产（开工前置，本地查不到）

1. 注册企业微信（个人微信扫码即可，免费）。
2. 应用管理 → 自建应用「Kairo 投研助手」：
   - 取 `corpid` / `corpsecret` / `agentid`
   - 接收消息 → 填回调 URL `https://<cpolar 域名>/api/wechat/callback`，生成 `Token` + `EncodingAESKey`
   - 可见范围加你自己（主动推送只能推给可见范围内的人）
3. 本地起隧道：`cpolar http 3000`（dev 端口按实际），拿 https 域名填回调。
   - ⚠️ cpolar 免费隧道**每次重启换域名** → 要么用 cpolar 付费固定域 / frpc 固定域，要么重启后重填回调。建议 frpc 或付费固定域。

## 3. 代码改动清单（全部新增，不碰 Qoder 的 R20b 文件）

| 文件 | 类型 | 职责 |
|---|---|---|
| `src/lib/wechat/wecom.ts` | 新增 | 企微客户端纯函数：`getAccessToken`(内存缓存 7200s)、`sendText`(markdown)、`verifyCallback`(GET 验签)、`decryptMessage`(AES 解密)、`encryptReply` |
| `src/app/api/wechat/callback/route.ts` | 新增 | GET 验 URL（回 echostr）；POST 解密→抽文本→调 AI→加密回包 |
| `src/app/api/wechat/push/route.ts` | 新增 | 主动推送：重算 risk，等级 ≥ 阈值则 `sendText` 预警 |
| `src/lib/quant/screener/drop-reason-core.ts` | 新增 | 「今日为什么跌」纯核（零 IO）：组装风险触发器 + 市场阶段 + 领跌板块 + 负面催化 |
| `src/app/api/market/drop-reason/route.ts` | 新增 | 暴露 drop-reason 端点 |
| `src/components/desk/pages/RiskPage.tsx` + 留档链 | 小改 | 挂「收盘自动 push」+「推今日解读」手动按钮 |
| `src/lib/wechat/voice.ts` | 新增 | 语音消息：企微回调收语音(media_id)→下载 AMR→转文字→进对话链路（先文字后语音，语音后置） |
| agent 工具面（`skills-core.ts` BUILTIN_SKILLS / `agent-tools.ts`） | 小改 | 增补 1~2 个「本机只读查询」工具（查文件存在/读配置/查库表），对标截图「查本机凭据」效果；**只读白名单**，不开放任意 shell |

所有 key 走 `.env`，不写死；新增文件与 Qoder 当前 R20b 改动（`top-pressure-core.ts` / `top-risk-core.ts` / `limit-up-roster-core.ts`）零交集。

## 4. 数据流

- **对话链路**：微信发消息 → `/api/wechat/callback` POST → AES 解密 → 抽文本 → 调 `/api/ai/chat`（复用 10 工具 + 证据链大脑）→ 加密回包。
  - 企微要求 **5s 内回** → 先回「收到，稍候」ack，AI 算完用主动推送（`sendText`）补结果（异步必选项）。
- **预警推送链路**：收盘重算 `/api/snapshot/risk`（或 `sentiment.ts`）→ `level ≥ 偏高` → `push` 发 markdown（triggers + 见顶压力分 + 领跌板块）。
- **今日为什么跌链路**：对话命中「为什么跌 / 跌因」意图 → 调 `drop-reason-core` 组装四块证据。

## 5. 复用（不重造）

| 能力 | 现有位置 |
|---|---|
| AI 大脑（10 工具 + 证据链） | `src/app/api/ai/chat/route.ts` |
| 风险触发器 / 高风险档 | `src/lib/quant/screener/sentiment.ts`（R20a 已补活）、`top-risk-core.ts` |
| 见顶压力分 | `src/lib/quant/screener/top-pressure-core.ts`（R20b WIP，接其已稳定输出） |
| 市场阶段 | `src/lib/quant/review/market-inference.ts` |
| 板块领跌 | `src/app/api/market/sectors/route.ts`（板块内上涨/下跌家数） |
| 负面催化 | `src/lib/quant/screener/event-interpret-core.ts` |

## 6. 环境变量（`.env`，新增）

```
WECOM_CORPID=
WECOM_CORPSECRET=
WECOM_AGENTID=
WECOM_TOKEN=
WECOM_AESKEY=
WECOM_PUSH_LEVEL=偏高        # 触发主动推送的最低风险档
WECOM_CALLBACK_PUBLIC_URL=   # cpolar/frpc 公网域名，用于异步回推结果
```

## 7. 安全与边界

- 回调必须验签（`msg_signature`）+ AES 解密；`EncodingAESKey` / `corpsecret` 走 env，不进仓库。
- `access_token` 内存缓存（7200s），不每次请求现取。
- 5s 回包硬约束 → 异步模式（收到即 ack，结果用主动推送补）。
- 主动推送仅到「应用可见范围」内的人（你自己），不能推任意微信好友。
- **本机工具只做只读白名单**（查文件存在 / 读配置 / 查库表 / 只读命令），不开放任意 shell——对标截图「查凭据」这类能力必须有边界，否则等于把机器交给微信消息。
- 沿用现有禁令：AI 输出不编概率 / 不编涨跌预测（`event-interpret-core.ts` §九 剥离逻辑）。

## 8. 实现顺序（里程碑）

1. **你**：建企微应用 + 起 cpolar，给 `corpid/secret/agentid/token/aeskey`（或自填 `.env`）。
2. **我**：写 `wecom.ts` + `callback` + `push` + `drop-reason-core` + 端点；RiskPage 加按钮。
3. **联调**：企微发「今天 A 股为什么跌」→ 收到归因；手动 push → 微信收到预警 markdown。
4. **挂自动**：收盘重算 risk → 自动 push（scheduler 或留档钩子）。
5. **扩展**：本机只读查询工具（对标截图「查凭据」效果）→ 语音消息（AMR 转文字），均在前四步稳定后再做。

## 9. 风险 / 未决

- cpolar 免费隧道域名随重启变化 → 用 frpc / 付费固定域，否则每次重启重填回调。
- R20b 见顶压力分仍在写（未提交），`drop-reason-core` 接其**已稳定**输出，避免接半成品。
- 企微 5s 超时对长 AI 回复是硬约束，异步推为必选项（非优化项）。
- 语音转文字选型未定：本地 ASR（whisper.cpp，离线但慢）vs 云端（快、要 key）。**默认先做文字为主、语音后置**，语音不阻塞主链路上线。

## 10. 验收标准

- 企微发「今天 A 股为什么跌」→ 收到归因（风险触发器 + 领跌板块 + 市场阶段）。
- 风险升到「偏高」→ 微信收到预警 markdown（triggers + 见顶压力分 + 领跌板块）。
- 手动「推今日解读」按钮 → 微信收到。
- 全程不碰 R20b 文件；`npx tsc --noEmit` 0 错；现有测试不退化。
