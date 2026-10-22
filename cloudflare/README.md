# Cloudflare Worker 中继（可选）

站点仍托管在 Netlify，只是把 **AI 中继**从 Netlify Function 搬到 Cloudflare Worker。
用途：Netlify 的部署额度用完后，Functions 仍可运行，但**新部署会被暂停**。
搬到 Cloudflare 之后，中继的更新不再受 Netlify 额度影响。

## 为什么需要这一步

`netlify/functions/ai-chat.mjs` 与 `cloudflare/ai-chat-worker.js` 是**同一份业务逻辑**，
差异只有三处：

| 差异点 | Netlify | Cloudflare |
|---|---|---|
| 入口 | `export default (req)` | `export default { fetch(request, env) }` |
| 环境变量 | `process.env` | `env` 参数 |
| 跨域 | 同源，不需要 | **必须处理 CORS** |

核心函数（`callGemini`、`mapUpstreamError`、`buildProposalSchema`、限流、校验）
完全一致，Node 侧测试覆盖的就是这些函数本身。

## 部署方式一：网页粘贴（最快）

1. Cloudflare 后台 → **Workers & Pages** → **Create** → **Create Worker**
2. 起个名字（例如 `schedule-ai-chat`）→ Deploy
3. 点 **Edit code**，把 `cloudflare/ai-chat-worker.js` 的**全部内容**粘贴进去
4. Deploy 一次

> 这个文件是自包含的：没有 import、没有依赖，可以整份粘贴。

## 部署方式二：wrangler 命令行

```bash
cd "/Users/songqingan/Downloads/Schedule(SDL WEEK）"
npx wrangler login
npx wrangler secret put GEMINI_API_KEY     # 粘贴你的 key
npx wrangler deploy
```

`wrangler.toml` 已配置好入口与 `ALLOWED_ORIGINS`。

## 必须配置的变量

Worker → **Settings** → **Variables and Secrets**：

| 名称 | 必填 | 说明 |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | 你的 Gemini key。用 **Secret** 类型，不要用明文变量 |
| `ALLOWED_ORIGINS` | ✅ | `https://powerschedule.netlify.app`。**跨域时这是主要防线**，填错会导致前端被 403 |
| `GEMINI_MODEL` | 建议 | 例如 `gemini-3.5-flash` |
| `GEMINI_MODEL_FALLBACK` | 可选 | 主模型过载时的备用模型 |
| `AI_DEBUG_ERRORS` | 仅排查 | 设为 `1` 会在响应里附带上游诊断，**排查完务必删掉** |

## 让前端指向 Worker

编辑 `index.html` 里这一行（**注意不能删掉这个 script**）：

```html
<script>
  window.__AI_ENDPOINT__ = 'https://schedule-ai-chat.<你的子域>.workers.dev';
</script>
```

留空则回落到同源的 `/.netlify/functions/ai-chat`。
改完需要**重新部署站点**（这个改动在 Netlify 那边，受额度限制）。

## 验证

在站点页面按 F12 打开 Console：

```js
fetch(window.__AI_ENDPOINT__, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] })
}).then(r => r.json()).then(console.log)
```

- `{"ok":true,"reply":"..."}` → 通了
- `403 origin_rejected` → `ALLOWED_ORIGINS` 没填对
- `503 missing_api_key` → 变量没读到（Secret 名字拼错，或没重新部署）
- 浏览器报 CORS 错误 → 检查 Worker 是否最新版本（早期版本没有 CORS 头）

## 已知限制

- **限流是进程内的**：Workers 会横向扩展，每个实例各自计数，
  实际允许量会高于配置值。需要严格配额时改用 Durable Object 或 KV。
- 迁移期间可以**两边并存**：Netlify 函数不删也不影响 Worker。
  确认 Worker 稳定后，再把 `src/ai/chatClient.js` 的默认值也改掉（可选）。
