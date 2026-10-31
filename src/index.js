// index.js —— v2 中转服务的 HTTP 入口
//
// 只做三件事：鉴权、路由到「这个 Bot 对应的 Durable Object」、补 CORS 头。
// 真正的轮询 / AI / 回复逻辑全在 weixinBot.js 的 DO 里。

import { WeixinBot } from './weixinBot.js';

// ⚠️ wrangler 的 DO 绑定要求类从主模块导出，缺这行部署会报找不到 class。
export { WeixinBot };

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders()),
  });
}

function authed(request, url, env) {
  if (!env.RELAY_TOKEN) return true;
  const given = url.searchParams.get('token') || request.headers.get('X-Relay-Token') || '';
  return given === env.RELAY_TOKEN;
}

/** 每个 Bot 一个 DO 实例：用 botId 做名字 */
function botStub(env, botId) {
  const name = String(botId || 'default');
  const id = env.BOT.idFromName(name);
  return env.BOT.get(id);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // 探活 / 取 VAPID 公钥：不涉及隐私，不鉴权
    if (path === '' || path === '/' || path === '/health') {
      return json({ ok: true, service: 'wonderdraft-weixin-v2', mode: 'managed' });
    }
    if (path === '/vapid-public-key') {
      return json({ ok: true, publicKey: env.VAPID_PUBLIC_KEY || '' });
    }

    if (!authed(request, url, env)) {
      return json({ ok: false, message: 'token 不正确' }, 401);
    }

    if (!path.startsWith('/v2/')) {
      return json({ ok: false, message: '未识别的路径' }, 404);
    }
    const sub = path.slice('/v2'.length) || '/';

    // botId 可以从 query 或 body 里来（GET 用 query，POST 优先 body）
    let botId = url.searchParams.get('botId') || '';
    let body = null;
    if (request.method === 'POST' || request.method === 'PUT') {
      try { body = await request.json(); } catch (e) { body = null; }
      if (!botId && body && body.botId) botId = body.botId;
    }
    if (!botId) botId = 'default';

    const stub = botStub(env, botId);

    try {
      if (sub === '/config' && request.method === 'POST') {
        const r = await stub.fetch('https://do/config', {
          method: 'POST',
          body: JSON.stringify(body || {}),
          headers: { 'Content-Type': 'application/json' },
        });
        return json(await r.json(), r.status);
      }

      if (sub === '/start' && request.method === 'POST') {
        const r = await stub.fetch('https://do/start', { method: 'POST' });
        return json(await r.json(), r.status);
      }
      if (sub === '/stop' && request.method === 'POST') {
        const r = await stub.fetch('https://do/stop', { method: 'POST' });
        return json(await r.json(), r.status);
      }

      if (sub === '/state') {
        const r = await stub.fetch('https://do/state');
        return json(await r.json(), r.status);
      }

      if (sub === '/push/subscribe' && request.method === 'POST') {
        const r = await stub.fetch('https://do/push/subscribe', {
          method: 'POST',
          body: JSON.stringify(body || {}),
          headers: { 'Content-Type': 'application/json' },
        });
        return json(await r.json(), r.status);
      }
      if (sub === '/push/unsubscribe' && request.method === 'POST') {
        const r = await stub.fetch('https://do/push/unsubscribe', {
          method: 'POST',
          body: JSON.stringify(body || {}),
          headers: { 'Content-Type': 'application/json' },
        });
        return json(await r.json(), r.status);
      }

      if (sub === '/sync' && request.method === 'POST') {
        const r = await stub.fetch('https://do/sync', {
          method: 'POST',
          body: JSON.stringify(body || {}),
          headers: { 'Content-Type': 'application/json' },
        });
        return json(await r.json(), r.status);
      }

      if (sub === '/test-push' && request.method === 'POST') {
        const r = await stub.fetch('https://do/test-push', { method: 'POST' });
        return json(await r.json(), r.status);
      }

      // SSE：直接把 DO 的流式响应原路返回（要保留 stream headers）
      if (sub === '/stream') {
        const upstream = await stub.fetch('https://do/stream');
        const headers = Object.assign({}, corsHeaders());
        for (const k of ['Content-Type', 'Cache-Control', 'Connection']) {
          const v = upstream.headers.get(k);
          if (v) headers[k] = v;
        }
        return new Response(upstream.body, { status: upstream.status, headers });
      }

      return json({ ok: false, message: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, message: String(e?.message || e) }, 500);
    }
  },
};
