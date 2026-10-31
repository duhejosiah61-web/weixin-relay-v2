// push.js —— Web Push（VAPID）发送
//
// 用 web-push-browser：零依赖、能在 Workers / Deno / Bun 里跑（不像 web-push 依赖 Node crypto）。
// 密钥存在 Worker 的 secret 里：VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT。
// 前端拿 public key 调 PushManager.subscribe()，把 Subscription 回传给我们存进 DO。

import * as wp from 'web-push-browser';

let cachedKeyPair = null;

async function keyPair(env) {
  if (cachedKeyPair) return cachedKeyPair;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  cachedKeyPair = await wp.deserializeVapidKeys({
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  });
  return cachedKeyPair;
}

/**
 * 给一个订阅推一条通知。失败静默（订阅过期是常态）。
 * @returns {Promise<boolean>} 是否成功（或至少没被判为“订阅失效”）
 */
export async function sendWebPush(env, subscription, payload) {
  if (!subscription?.endpoint || !subscription?.keys) return false;
  const kp = await keyPair(env);
  if (!kp) return false;
  try {
    const fn = wp.sendPushNotification;
    const res = await fn(
      kp,
      { endpoint: subscription.endpoint, keys: subscription.keys },
      env.VAPID_SUBJECT || 'mailto:admin@example.com',
      JSON.stringify(payload),
    );
    if (res && res.status >= 400) return false;
    return true;
  } catch (e) {
    console.warn('[push] 发送失败：', e?.message || e);
    return false;
  }
}

/** 订阅是否已失效（404/410），让调用方清理 */
export function isDeadSubscription(err) {
  const code = err?.statusCode || err?.status || 0;
  return code === 404 || code === 410;
}
