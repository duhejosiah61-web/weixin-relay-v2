// callAI.js —— AI 调用核心（复刻自前端 src/setting/api/ApiSetting.js）
//
// 服务端只保留「够用且稳」的核心：
//   - 端点点 normalization（自动补 /chat/completions）
//   - 温度 / max_tokens 处理（含服务商拒绝后折半降级）
//   - SSE 流式与整块 JSON 两种响应都要能解析
//   - 429 / 5xx 退避重试
// 前端那些 heavy 能力（记忆 RAG、世界书二次注入、工具调用闭环）不在服务端复刻：
// 记忆与世界书由前端在上传配置时**预先拼进角色快照的 worldbookText / recentBlock**，
// 保证服务端 prompt 与手机端口径一致，同时不必把整套数据层搬过来。

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const maxTokensCeiling = new Map();

function normalizeEndpoint(endpoint) {
  let e = String(endpoint || '').trim();
  try {
    const u = new URL(e);
    if (!u.pathname.includes('/chat/completions') && !u.pathname.includes('/v1/messages')) {
      u.pathname = u.pathname.replace(/\/+$/, '') + '/chat/completions';
    }
    return u.toString();
  } catch (e2) {
    if (!e.includes('/chat/completions') && !e.includes('/v1/messages')) {
      e = e.replace(/\/+$/, '') + '/chat/completions';
    }
    return e;
  }
}

function extractContent(obj) {
  const ch = obj && obj.choices && obj.choices[0];
  if (!ch) return '';
  const msg = ch.message || {};
  const delta = ch.delta || {};
  if (typeof msg.content === 'string' && msg.content) return msg.content;
  if (typeof delta.content === 'string' && delta.content) return delta.content;
  if (typeof msg.content === 'string') return msg.content;
  if (typeof delta.content === 'string') return delta.content;
  return '';
}

/** 从响应体文本里解析出正文：自动识别 SSE 与整块 JSON */
function parseBody(textBody) {
  // 只看首个非空行是否以 data: 开头（不能用 includes，正文里可能有 data:image 之类）
  const firstLine = textBody.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  if (firstLine.startsWith('data:')) {
    const lines = textBody.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const parts = [];
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const c = extractContent(JSON.parse(payload));
        if (c) parts.push(c);
      } catch (e) { /* 跳过残留行 */ }
    }
    return parts.join('');
  }
  try {
    return extractContent(JSON.parse(textBody));
  } catch (e) {
    return '';
  }
}

/**
 * 调一次 AI。
 * @param {{endpoint:string,key:string,model:string}} profile
 * @param {Array<{role:string,content:string|Array}>} messages
 * @param {{temperature?:number,max_tokens?:number,maxRetries?:number,timeoutMs?:number}} [opts]
 * @returns {Promise<string>} 正文
 */
export async function callAI(profile, messages, opts = {}) {
  if (!profile?.endpoint || !profile?.key) throw new Error('AI 配置缺失（endpoint/key）');
  const endpoint = normalizeEndpoint(profile.endpoint);
  const model = String(profile.model || '').trim() || 'deepseek-chat';
  const isOSeries = /^o[134](-|$)/i.test(model);
  const maxRetries = opts.maxRetries ?? 2;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60000;

  const msgs = messages.map((m) => {
    const copy = { ...m };
    if (Array.isArray(copy.content)) {
      copy.content = copy.content.filter((p) => p && typeof p === 'object');
    } else {
      const t = copy.content == null ? '' : String(copy.content);
      copy.content = t.trim().length > 0 ? t : ' ';   // DeepSeek 不许空 content
    }
    return copy;
  });

  let desiredMax = opts.max_tokens ?? 900;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let effectiveMax = desiredMax;
    const ceiling = maxTokensCeiling.get(model);
    if (typeof effectiveMax === 'number' && effectiveMax > 0 && ceiling && ceiling < effectiveMax) {
      effectiveMax = ceiling;
    }

    const payload = { model, messages: msgs };
    if (!isOSeries) {
      const temp = Number(opts.temperature ?? 0.85);
      payload.temperature = isNaN(temp) ? 0.85 : Math.max(0, Math.min(2, temp));
    }
    if (isOSeries) payload.max_completion_tokens = Math.max(1, Number(effectiveMax) || 900);
    else payload.max_tokens = Math.max(1, Number(effectiveMax) || 900);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.key.trim()}` },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(t);
      if (attempt < maxRetries) { await delay(1000 * (attempt + 1)); continue; }
      throw new Error(`AI 网络请求失败：${e.message || e}`);
    }
    clearTimeout(t);

    const bodyText = await res.text();

    if (res.status === 429) {
      if (attempt < maxRetries) {
        const ra = res.headers.get('retry-after');
        let waitMs = 1500 * Math.pow(2, attempt) + Math.random() * 500;
        const n = ra ? parseInt(ra, 10) : NaN;
        if (!isNaN(n) && n > 0) waitMs = n * 1000;
        await delay(waitMs);
        continue;
      }
      throw new Error('AI 限流 (429)，已重试多次');
    }

    if (!res.ok) {
      const detail = String(bodyText).slice(0, 200);
      // 输出上限被拒 → 折半降级重试（不消耗重试次数）
      if (res.status === 400 && typeof effectiveMax === 'number' && effectiveMax > 1024
        && /max_tokens|max_completion_tokens|maximum|too\s*large|exceed/i.test(detail)) {
        const next = Math.max(1024, Math.floor(effectiveMax / 2));
        maxTokensCeiling.set(model, next);
        desiredMax = next;
        attempt--;
        continue;
      }
      if (res.status >= 500 && res.status <= 504 && attempt < maxRetries) {
        await delay(1000 * (attempt + 1));
        continue;
      }
      throw new Error(`AI 请求失败 [HTTP ${res.status}]: ${detail}`);
    }

    const content = parseBody(bodyText);
    if (!content) {
      if (attempt < maxRetries) { await delay(1000 * (attempt + 1)); continue; }
      throw new Error('AI 返回空内容');
    }
    return content;
  }
  throw new Error('AI 调用失败（重试耗尽）');
}
