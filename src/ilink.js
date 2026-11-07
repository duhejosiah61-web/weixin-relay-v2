// ilink.js —— 微信 iLink Bot 协议层（服务端版）
//
// 复刻自小手机前端的 src/apps/NativeBridge/weixin/weixinIlink.js，
// 去掉了「经过中转 / CapacitorHttp」的通道差异，改为服务端直接 fetch ilinkai.weixin.qq.com
// （服务端没有 CORS 限制，直接打即可）。
//
// 只保留「全托管」用得到的：拉消息、发文字、发「正在输入」、收图解密。
// 发图（CDN 加密上传）本期不做——v2 暂只回文字，模型想发的图会以文字描述降级。

const BASE_INFO = { channel_version: '1.0.2' };
const ILINK_HOST = 'https://ilinkai.weixin.qq.com';
export const ERR_TOKEN_EXPIRED = -14;

function randomUint32() {
  try {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    return new DataView(buf.buffer).getUint32(0);
  } catch (e) {
    return Math.floor(Math.random() * 0xffffffff);
  }
}
function toBase64(str) {
  try { return btoa(unescape(encodeURIComponent(str))); } catch (e) { return str; }
}
function uuid() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function buildHeaders(botToken) {
  const headers = { 'Content-Type': 'application/json', 'iLink-App-ClientVersion': '1' };
  if (botToken) {
    headers.Authorization = `Bearer ${botToken}`;
    headers.AuthorizationType = 'ilink_bot_token';
    headers['X-WECHAT-UIN'] = toBase64(String(randomUint32()));
  }
  return headers;
}

// 服务端直连：带超时
async function ilinkRequest({ path, method = 'POST', headers, body, timeoutMs = 15000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ILINK_HOST + path, {
      method,
      headers,
      body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    return { status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

async function callJson(path, { botToken, body, method = 'POST', timeoutMs } = {}) {
  const res = await ilinkRequest({ path, method, headers: buildHeaders(botToken), body, timeoutMs });
  if (res.status < 200 || res.status >= 300) {
    const peek = typeof res.data === 'string' ? res.data.slice(0, 200) : JSON.stringify(res.data).slice(0, 200);
    throw new Error(`iLink HTTP ${res.status}: ${peek}`);
  }
  if (typeof res.data !== 'object' || res.data === null) throw new Error('iLink 返回内容不是 JSON');
  return res.data;
}

// ── 收消息 ──

export async function getUpdates(botToken, cursor = '', timeoutMs = 6000) {
  const data = await callJson('/ilink/bot/getupdates', {
    botToken,
    body: { get_updates_buf: cursor || '', base_info: BASE_INFO },
    timeoutMs,
  });
  if (data.error_code === ERR_TOKEN_EXPIRED) return { messages: [], cursor, tokenExpired: true };
  const rawMsgs = Array.isArray(data.msgs) ? data.msgs : [];
  return {
    messages: rawMsgs.map(normalizeIncoming).filter(Boolean),
    cursor: data.get_updates_buf || cursor || '',
    tokenExpired: false,
  };
}

function normalizeIncoming(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const items = Array.isArray(msg.item_list) ? msg.item_list : [];
  let text = '';
  let imageItem = null;
  let fileItem = null;
  let otherType = 0;
  let hasVoice = false;
  let voiceDuration = 0;
  for (const it of items) {
    if (!it) continue;
    if (it.type === 1 && it.text_item?.text) text += it.text_item.text;
    // type 2 = 图片（含表情/贴图）；type 3 = 语音；type 4 = 文件
    else if (it.type === 2) imageItem = it.image_item || null;
    else if (it.type === 3) {
      hasVoice = true;
      const vt = it.voice_item || {};
      voiceDuration = Number(vt.playtime || 0) || 0;
      const vtText = String(vt.text || '').trim();
      if (vtText) text += (text ? ' ' : '') + vtText;
    }
    else if (it.type === 4) {
      fileItem = it.file_item || null;
    }
    else if (it.type && it.type !== 1) otherType = it.type;
  }
  return {
    messageId: msg.message_id,
    fromUserId: String(msg.from_user_id || ''),
    toUserId: String(msg.to_user_id || ''),
    contextToken: String(msg.context_token || ''),
    text: text.trim(),
    hasImage: !!imageItem,
    imageItem,
    hasFile: !!fileItem,
    fileItem,
    hasVoice,
    voiceDuration,
    otherType,
  };
}

// ── 发消息 ──

function buildMsg({ toUserId, contextToken, itemList }) {
  return {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: uuid(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: itemList,
    },
    base_info: BASE_INFO,
  };
}
function assertSendResult(data) {
  if (data.ret !== undefined && data.ret !== 0) throw new Error(data.errmsg || `发送失败 ret=${data.ret}`);
}

export async function sendTextMessage({ botToken, toUserId, contextToken, text }) {
  const data = await callJson('/ilink/bot/sendmessage', {
    botToken,
    body: buildMsg({ toUserId, contextToken, itemList: [{ type: 1, text_item: { text: String(text || '') } }] }),
  });
  assertSendResult(data);
  return true;
}

export async function sendTyping({ botToken, toUserId, contextToken }) {
  try {
    const cfg = await callJson('/ilink/bot/getconfig', {
      botToken,
      body: { to_user_id: toUserId, context_token: contextToken, base_info: BASE_INFO },
      timeoutMs: 8000,
    });
    const ticket = cfg.typing_ticket || cfg.typingTicket || '';
    if (!ticket) return false;
    await callJson('/ilink/bot/sendtyping', {
      botToken,
      body: { to_user_id: toUserId, typing_ticket: ticket, base_info: BASE_INFO },
      timeoutMs: 8000,
    });
    return true;
  } catch (e) {
    return false;
  }
}

// ── 收图解密（纯 JS AES-128-ECB，与前端口径一致）──

export async function fetchImageDataUrl(imageItem) {
  try {
    const media = imageItem?.media || {};
    const param = String(media.encrypt_query_param || '').trim();
    const keyB64 = String(media.aes_key || '').trim();
    if (!param || !keyB64) return null;
    const aesKey = decodeAesKey(keyB64);
    if (!aesKey || aesKey.length !== 16) return null;
    const url = `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(param)}`;
    const res = await fetch(url, { method: 'GET' });
    if (res.status < 200 || res.status >= 300) return null;
    const buf = await res.arrayBuffer();
    const cipher = new Uint8Array(buf);
    if (!cipher.length) return null;
    const plain = aes128EcbDecryptJS(cipher, aesKey);
    if (!plain.length) return null;
    const unpadded = stripPadding(plain);
    const mime = sniffImageMime(unpadded) || 'image/jpeg';
    let bin = '';
    for (let i = 0; i < unpadded.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, unpadded.subarray(i, i + 0x8000));
    }
    return { dataUrl: `data:${mime};base64,${btoa(bin)}`, mime };
  } catch (e) {
    console.warn('[ilink] 图片下载/解密失败', e?.message || e);
    return null;
  }
}

// ── 收文件解密与文本/图像内容提取 ──

export async function fetchFileDetails(fileItem) {
  const fileName = String(fileItem?.file_name || '未命名文件').trim();
  const fileLen = Number(fileItem?.len || 0);
  const sizeStr = formatFileSize(fileLen);

  try {
    const media = fileItem?.media || {};
    const param = String(media.encrypt_query_param || '').trim();
    const keyB64 = String(media.aes_key || '').trim();
    if (!param || !keyB64) {
      return { ok: true, fileName, sizeStr, textContent: '', isImage: false, dataUrl: '' };
    }

    const aesKey = decodeAesKey(keyB64);
    if (!aesKey || aesKey.length !== 16) {
      return { ok: true, fileName, sizeStr, textContent: '', isImage: false, dataUrl: '' };
    }

    const url = `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(param)}`;
    const res = await fetch(url, { method: 'GET' });
    if (res.status < 200 || res.status >= 300) {
      return { ok: true, fileName, sizeStr, textContent: '', isImage: false, dataUrl: '' };
    }

    const buf = await res.arrayBuffer();
    const cipher = new Uint8Array(buf);
    if (!cipher.length) {
      return { ok: true, fileName, sizeStr, textContent: '', isImage: false, dataUrl: '' };
    }

    const plain = aes128EcbDecryptJS(cipher, aesKey);
    if (!plain.length) {
      return { ok: true, fileName, sizeStr, textContent: '', isImage: false, dataUrl: '' };
    }

    const unpadded = stripPadding(plain);

    // 1. 检查是否是以文件形式发送的图片
    const imageMime = sniffImageMime(unpadded);
    if (imageMime || /\.(jpe?g|png|gif|webp|bmp)$/i.test(fileName)) {
      const mime = imageMime || 'image/jpeg';
      let bin = '';
      for (let i = 0; i < unpadded.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, unpadded.subarray(i, i + 0x8000));
      }
      return {
        ok: true,
        fileName,
        sizeStr,
        isImage: true,
        dataUrl: `data:${mime};base64,${btoa(bin)}`,
        mime,
        textContent: ''
      };
    }

    // 2. 检查常见文本文件（txt, md, json, csv, code 等）
    let textContent = '';
    const ext = fileName.toLowerCase().split('.').pop() || '';
    const textExts = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'html', 'css', 'vue', 'xml', 'yaml', 'yml', 'sh', 'bat', 'sql', 'ini', 'conf', 'env'];
    let isLikelyText = textExts.includes(ext);
    if (!isLikelyText && unpadded.length > 0) {
      let nullCount = 0;
      const checkLen = Math.min(unpadded.length, 500);
      for (let i = 0; i < checkLen; i++) {
        if (unpadded[i] === 0) nullCount++;
      }
      if (nullCount === 0) isLikelyText = true;
    }

    if (isLikelyText) {
      try {
        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(unpadded);
        if (decoded && decoded.trim()) {
          textContent = decoded.slice(0, 15000).trim();
          if (decoded.length > 15000) {
            textContent += '\n...（篇幅过长，已截取前 15000 字符）';
          }
        }
      } catch (e) { /* ignore */ }
    } else if (ext === 'pdf') {
      textContent = extractSimplePdfText(unpadded);
    }

    return {
      ok: true,
      fileName,
      sizeStr,
      isImage: false,
      dataUrl: '',
      textContent
    };
  } catch (e) {
    console.warn('[ilink] 文件下载/解析失败', e?.message || e);
    return { ok: true, fileName, sizeStr, textContent: '', isImage: false, dataUrl: '' };
  }
}

function formatFileSize(bytes) {
  if (!bytes || isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extractSimplePdfText(unpadded) {
  try {
    const raw = new TextDecoder('latin1').decode(unpadded);
    const matches = raw.match(/\(([^()]{2,100})\)\s*Tj/g);
    if (matches && matches.length > 0) {
      const texts = matches.map(m => m.replace(/^\(/, '').replace(/\)\s*Tj$/, '').trim()).filter(Boolean);
      const joined = texts.join(' ');
      if (joined.length >= 20) return joined.slice(0, 8000);
    }
  } catch (_) {}
  return '';
}

function hexToBytes(hex) { const o = new Uint8Array(hex.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(hex.substr(i * 2, 2), 16); return o; }
function bytesToBase64(bytes) { let bin = ''; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)); return btoa(bin); }
function sniffImageMime(b) { if (!b || b.length < 4) return ''; if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'; if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) return 'image/png'; if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'; if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp'; return ''; }
function stripPadding(b) { const pad = b[b.length - 1]; if (pad > 0 && pad <= 16 && pad <= b.length) return b.subarray(0, b.length - pad); return b; }
function decodeAesKey(keyB64) {
  try {
    const bin = atob(keyB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length === 16) return bytes;
    const asText = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    if (/^[0-9a-fA-F]{32}$/.test(asText)) return hexToBytes(asText);
    return null;
  } catch (e) { return null; }
}

const AES_SBOX = (() => {
  const s = new Uint8Array(256);
  s[0] = 0x63;
  let p = 1, q = 1;
  do {
    p = p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0);
    p &= 0xff;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    s[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  return s;
})();
const AES_INV_SBOX = (() => { const inv = new Uint8Array(256); for (let i = 0; i < 256; i++) inv[AES_SBOX[i]] = i; return inv; })();
function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }
function expandKey(keyBytes) {
  const w = new Uint8Array(176);
  w.set(keyBytes.slice(0, 16));
  const rcon = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
  for (let i = 16, r = 0; i < 176; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) { const tmp = t0; t0 = AES_SBOX[t1] ^ rcon[r++]; t1 = AES_SBOX[t2]; t2 = AES_SBOX[t3]; t3 = AES_SBOX[tmp]; }
    w[i] = w[i - 16] ^ t0; w[i + 1] = w[i - 15] ^ t1; w[i + 2] = w[i - 14] ^ t2; w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}
function decryptBlock(block, w) {
  const inv = AES_INV_SBOX;
  let s = addRoundKey(block, w, 10);
  for (let round = 9; round > 0; round--) { s = invShiftRows(s); s = invSubBytes(s, inv); s = addRoundKey(s, w, round); s = invMixColumns(s); }
  s = invShiftRows(s); s = invSubBytes(s, inv); s = addRoundKey(s, w, 0);
  return s;
}
function invSubBytes(s, inv) { const o = new Uint8Array(16); for (let i = 0; i < 16; i++) o[i] = inv[s[i]]; return o; }
function invShiftRows(s) { const o = new Uint8Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[4 * c + r] = s[4 * ((c - r + 4) % 4) + r]; return o; }
function addRoundKey(s, w, round) { const o = new Uint8Array(16); const off = round * 16; for (let i = 0; i < 16; i++) o[i] = s[i] ^ w[off + i]; return o; }
function invMixColumns(s) { const o = new Uint8Array(16); for (let c = 0; c < 4; c++) { const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3]; o[4 * c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9); o[4 * c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13); o[4 * c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11); o[4 * c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14); } return o; }
function mul(a, n) { let r = 0; for (let i = 0; i < 4; i++) { if (n & (1 << i)) r ^= a; a = xtime(a); } return r & 0xff; }
function aes128EcbDecryptJS(cipher, keyBytes) {
  const key = expandKey(keyBytes);
  const len = cipher.length - (cipher.length % 16);
  const out = new Uint8Array(len);
  for (let off = 0; off < len; off += 16) out.set(decryptBlock(cipher.subarray(off, off + 16), key), off);
  return out;
}
