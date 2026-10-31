# 草稿笨笨 —— 微信 iLink 中转服务 v2（服务端托管版）

> 如果你想要的是「纯转发、不落盘」，请用 **v1**（`workers/weixin-relay`）。
> v1 与 v2 是两个独立的 Worker，互不影响。

## v1 和 v2 到底差在哪

| | v1（纯转发） | v2（服务端托管，本项目） |
|---|---|---|
| 谁在轮询微信 | **浏览器 tab 里的 JS** | Worker 里的 Durable Object |
| 网页切后台 / 关掉 | JS 被浏览器冻结 → **不再回复** | DO 由 `alarm()` 唤醒 → **照样回复** |
| AI 回复在哪执行 | 浏览器（AI key 不出本机） | **服务端**（要上传 AI key） |
| 后端存了什么 | 什么都不存 | bot_token、AI key、角色人设、最近聊天缓冲 |
| 适合谁 | 只在乎隐私、只在电脑前用 | 想要「手机微信随时有人回」 |

**选 v2 的代价，必须先看清楚**：你的 **AI key 会存在 Cloudflare 的 Durable Object 里**。
Durable Object 的存储是加密的、别人访问不到，但原理上它确实离开了你的本机。
**不接受这一点就别用 v2，继续用 v1 + 安卓 App。**

---

## 它是怎么在后台活下来的

普通 Cloudflare Worker 只在收到请求时运行，没法自己轮询。
v2 靠的是 **Durable Object 的 alarm**：

```
alarm() 每 5 秒响一次
   └─ 调 iLink 拉新消息
        └─ 有消息 → 拼人设 prompt → 调你的 AI → 发回微信 → 推 Web Push
             └─ 临走前 ctx.storage.setAlarm(现在 + 5秒)   ← 自调度，形成永动循环
```

每个 Bot 一个 DO 实例（`idFromName(botId)`）。没有请求进来时 DO 也会被系统唤醒，
所以**关掉网页、关掉电脑都没关系**——这是链接版唯一能真正后台的方案。

alarm 的最小精度约 1 秒。这里取 5 秒，是为了在「回复够不够快」和「免费额度够不够用」之间取平衡：

```
# 仅轮询部分的消耗参考
# 5 秒轮询一次 → 约 1.7 万次/天，在 Workers 免费额度（10 万次/天）之内
# 想更实时可以改小，但别低于 2 秒——没必要，也容易撞额度
```

---

## 部署步骤

### 1. 生成 VAPID 密钥（Web Push 用）

```bash
npx web-push generate-vapid-keys
```

会输出 Public Key / Private Key，先存下来。

> 仓库里已经有 `package.json`，它依赖 `web-push-browser`（零依赖，能在 Workers 跑）。
> 装依赖：`npm install`

### 2. 填三个 secret

```bash
cd workers/weixin-relay-v2
npx wrangler@3.90.0 login

npx wrangler@3.90.0 secret put VAPID_PUBLIC_KEY
npx wrangler@3.90.0 secret put VAPID_PRIVATE_KEY
npx wrangler@3.90.0 secret put VAPID_SUBJECT
```

`VAPID_SUBJECT` 填一个邮箱，形如 `mailto:you@example.com`。

**（强烈建议）**再加一道访问口令，防止陌生人拿你的 Worker 白嫖额度：

```bash
npx wrangler@3.90.0 secret put RELAY_TOKEN
```

### 3. 部署

```bash
npx wrangler@3.90.0 deploy
```

输出形如 `https://wonderdraft-weixin-v2.<你的子域>.workers.dev`。

### 4. 在小手机里打开

微信接入 → 找到「链接版后台保活」→ 打开开关 → 填：

- **中转服务地址**：上一步输出的 workers.dev 地址
- **访问口令**：就是你设的 `RELAY_TOKEN`（没设就留空）

启用后会自动完成三件事：上传配置、订阅 Web Push、建立实时流。

> wrangler 会提示升级到 v4，**不用理它**（v4 换了命令语法）。

---

## 部署后自检

```bash
# 探活
curl https://<你的地址>/health
# → {"ok":true,"service":"wonderdraft-weixin-v2","mode":"managed"}

# 取 VAPID 公钥（前端订阅推送要用）
curl https://<你的地址>/vapid-public-key
```

设了 `RELAY_TOKEN` 的话，其它接口都要带 `?token=<你的口令>` 或 `X-Relay-Token` 头。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 探活，不鉴权 |
| `/vapid-public-key` | GET | 给前端订阅推送用，不鉴权 |
| `/v2/config` | POST | 上传 botToken / AI 配置 / 角色人设，`start:true` 时开始轮询 |
| `/v2/start` `/v2/stop` | POST | 启停轮询 |
| `/v2/state` | GET | 看运行状态、最近回复时间、报错 |
| `/v2/sync` | POST | 把本机聊天记录 / 世界书 / 近期动态同步上去 |
| `/v2/push/subscribe` | POST | 登记 Web Push 订阅 |
| `/v2/push/unsubscribe` | POST | 注销订阅 |
| `/v2/test-push` | POST | 发一条测试通知，验证推送通道 |
| `/v2/stream` | GET | SSE 实时流（网页开着时用它显示即时动态） |

---

## 已知限制（说在前面）

- **分段发送已支持**：模型的回复会按行拆成多条消息逐条发出（带打字节奏延迟，
  约 55ms/字 + 随机抖动），微信里看到的是一个个分开的气泡，不是一个大段落。
  上限 5 条/次，超过会把多余的文字合并到最后一条。
- **暂不支持发图 / 发表情包 / 发语音**：这三种都要先把媒体 AES-128-ECB 加密上传到
  微信 CDN（`getuploadurl` + CDN 上传 + 纯 JS 的 AES/MD5 实现），目前还没搬进 Worker。
  为此 **v2 的提示词里根本不提这些能力** —— 否则模型照指示写了一行指令、
  服务端却又忽略它，用户看到的就是「它什么都没回」（内容被清洗逻辑吞掉了）。
  安卓 App 端是全套支持的：表情包走聊天收藏、语音走角色声线、还能现场生图。
- **收图 / 收语音可以**：图会解密后给模型看；语音用微信自带的转写（`voice_item.text`），
  模型看到的是转出来的文字，不需要本地再做 STT。
- **记忆系统（RAG）不复刻**：v2 用的是「本机同步上来的最近聊天 + 世界书」做上下文，
  不做向量记忆检索。日常对话够用，超长期记忆还是以手机 App 为准。
- **多 Bot**：每个 Bot 一个 DO，理论上不限数量，但免费额度的 CPU 时间是共享的。
- **iOS**：Web Push 要求 iOS 16.4+ 且必须先「添加到主屏幕」，不支持的话开关会如实报错。

---

## 它会存什么（再说一次）

存在对应 Bot 的 Durable Object 里：

| 字段 | 为什么必须存 |
|---|---|
| `botToken` | 服务端要替你调微信 API，没 token 拉不到消息 |
| `aiProfile`（endpoint / key / model） | 服务端要替你调 AI |
| `char`（名字 / 人设 / 世界书文本） | 拼 prompt 用，不然会 OOC |
| `cursor` / `history` / `seen` | 记住拉到哪了、上下文、去重，防重复回复 |
| `pushSubs` | 往哪台设备推通知 |

**不含**：完整的聊天长历史（只保留最近 20 条作为上下文窗口）、任何与生成回复无关的数据。

**不会被转发到第三方**：配置和消息只在「这个 Worker → 微信服务器」和
「这个 Worker → 你自己填的 AI endpoint」之间流动，不经过其它任何地方
（v1 的中转地址也不会被用到，v2 是服务端直连微信，不再绕 CORS 转发）。

想彻底删掉：在 Cloudflare 后台删掉这个 Worker，或者——

```bash
npx wrangler@3.90.0 delete
```
