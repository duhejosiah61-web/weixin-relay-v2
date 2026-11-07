// weixinBot.js —— 一个 Bot 一个 Durable Object：服务端全托管的轮询引擎
//
// 为什么必须是 DO：普通 Worker 没有「常驻」概念，只有收到请求才跑。
// DO 的 alarm() 能在没有任何请求的情况下被系统唤醒 —— 这就是链接版的「后台保活」。
// alarm 里自调度（每 POLL_MS 一次），形成无限轮询循环；tab 关掉、进程被回收都不受影响。
//
// ⚠️ 与前端 KV/IDB 的关系：本 DO 有自己的一份 history/seen/cursor，用来在后台维持上下文。
//    前端打开时会把本地聊天记录同步上来覆盖（以本地为准，见 index.js 的 /sync）。

import {
  getUpdates, sendTextMessage, sendTyping, fetchImageDataUrl, fetchFileDetails,
} from './ilink.js';
import {
  buildWeixinSystem, buildUserContent, joinIncoming, parseReplySegments,
  parseNoteDirective, resolveReminderTime,
} from './prompt.js';
import { callAI } from './callAI.js';
import { sendWebPush } from './push.js';

const POLL_MS = 5000;        // 轮询间隔（alarm 自调度）
const COLLECT_MS = 1500;     // 连发合并窗口：收到消息后再等一小会儿
const STORAGE_HISTORY_MAX = 1000; // 服务端存储历史上限（大幅扩容至千条，基本等同于无上限，保证完整聊天记录永不丢弃并能回拉到客户端）
const CONTEXT_BUDGET_CHARS = 40000; // 发送给 LLM 的上下文预算上限（字符数保护，防止超长对话导致模型提供商报错 400 Context Length Exceeded）
const SEEN_TTL_MS = 10 * 60 * 1000;
const SEEN_MAX = 300;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 两条消息之间的等待，模拟真人打字节奏（约 55ms/字，抖动 ±30%）。
 * 完全均匀的间隔反而更假 —— 真人是打完一句、想一下、再打下一条。
 */
function replyDelay(prevText) {
  const chars = String(prevText || '').length;
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(900, Math.max(300, Math.round(chars * 22 * jitter)));
}

async function generateCharacterReminderMessages({ aiProfile, char, recentBlock, history, reminderText }) {
  const charName = char?.name || 'TA';
  if (!aiProfile || !char) {
    return [`刚看了一眼时间，想起提醒你一声：${reminderText}`];
  }

  try {
    const system = buildWeixinSystem(char, recentBlock);
    const prompt = `【你主动发起的日常约定/备忘提醒】：
你之前随手记下了一件提醒/约定事项：「${reminderText}」。
现在预定的时间已经到了。请你完全代入你（${charName}）的真实性格、语言习惯与当下的相处状态，主动在微信上给她发 1~2 句自然的日常消息，把这件事自然交代/叮嘱她。

严正要求：
- 像真人在微信上跟喜欢的人随口说话一样自然亲切（例如若是约好去吃饭就自然说“在XX门口了，收拾好没/慢慢走不着急”，若是提醒吃药/带东西就关切叮嘱）。
- 绝对不要带任何名字前缀（严禁出现“${charName}：”或“【提醒】”）。
- 绝对不要像系统机器人报时，绝对严禁出现“系统提醒/之前小纸条上记下的/到时间啦提醒你一下哦”等机械出戏的字眼！
- 分 1~2 行短句输出，每行表达一个念头，像平时发微信一样。`;

    const recentHistory = (history || []).slice(-6).map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.replace(/[\[【][\s:：\-_~^]*[\]】]/g, '').trim() : m.content,
    }));

    const messages = [
      { role: 'system', content: system },
      ...recentHistory,
      { role: 'user', content: prompt },
    ];

    const aiRes = await callAI(aiProfile, messages, {
      temperature: 0.85,
      max_tokens: 600,
      maxRetries: 1,
    });

    const rawReply = typeof aiRes === 'string' ? aiRes : (aiRes?.content || '');
    const cleaned = cleanWeixinReply(rawReply);
    const segs = parseReplySegments(cleaned).filter((x) => x.kind === 'text' && x.text);
    if (segs.length > 0) {
      return segs.map((x) => x.text);
    }
  } catch (e) {
    console.warn('[weixinBot] 生成角色口吻提醒失败，退回自然兜底', e);
  }

  return [`刚看了一眼时间，想起提醒你一声：${reminderText}`];
}

export class WeixinBot {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // SSE 连接句柄存在实例内存里（不落盘）。DO 被回收时丢失，前端会重连，无碍。
    this.listeners = [];
  }

  // ── 状态读写 ──
  async load() {
    const s = await this.ctx.storage.get('state');
    return s || {
      running: false, botToken: '', botId: '',
      aiProfile: null, char: null, recentBlock: '',
      cursor: '', history: [], seen: {}, lastContext: null,
      reminders: [], charNotes: [],
      pushSubs: [], runtime: { lastAt: 0, error: '', replied: 0 },
    };
  }
  async save(s) {
    await this.ctx.storage.put('state', s);
    return s;
  }

  // ── 生命周期 ──

  async start() {
    const s = await this.load();
    s.running = true;
    s.runtime = { ...(s.runtime || {}), error: '' };
    await this.save(s);
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    return { started: true };
  }

  async stop() {
    const s = await this.load();
    s.running = false;
    await this.save(s);
    await this.ctx.storage.deleteAlarm();
    return { stopped: true };
  }

  /** alarm 自调度：每 POLL_MS 再响一次 */
  async reschedule() {
    try { await this.ctx.storage.setAlarm(Date.now() + POLL_MS); } catch (e) { /* ignore */ }
  }

  async alarm() {
    let s = await this.load();
    if (!s.running || !s.botToken || !s.aiProfile) {
      // 没配好就别空转，但也不要自杀：保持 alarm 以便配好后立即接管
      if (s.running) await this.reschedule();
      return;
    }

    // 检查定时到期的小纸条提醒，主动向微信发送对白提醒
    const now = Date.now();
    if (s.reminders && s.reminders.length) {
      let changed = false;
      const firedTexts = new Set();
      for (const rem of s.reminders) {
        if (!rem.notified && rem.targetTime && rem.targetTime <= now) {
          rem.notified = true;
          rem.notifiedAt = now;
          changed = true;

          const normText = String(rem.text || '').trim();
          if (firedTexts.has(normText)) continue;
          firedTexts.add(normText);

          try {
            const botToken = s.botToken;
            const toUserId = rem.toUserId || s.lastUserId;
            const contextToken = s.lastContextToken || rem.contextToken;
            if (botToken && toUserId) {
              const remindMsgs = await generateCharacterReminderMessages({
                aiProfile: s.aiProfile,
                char: s.char,
                recentBlock: s.recentBlock,
                history: s.history,
                reminderText: rem.text,
              });

              for (const msgText of remindMsgs) {
                await sendTextMessage({
                  botToken,
                  toUserId,
                  contextToken,
                  text: msgText,
                });
                s.history = s.history || [];
                s.history.push({ role: 'assistant', content: msgText });
                await new Promise((r) => setTimeout(r, 450));
              }
              s.runtime = { ...(s.runtime || {}), replied: (s.runtime?.replied || 0) + remindMsgs.length };
            }
          } catch (e) {
            console.warn('[weixinBot] 提醒消息发送失败', e);
          }
          await this.notify(s, {
            title: `${rem.charName || 'TA'} 的小纸条提醒`,
            body: `叮嘱：${rem.text}`,
            tag: 'char-reminder',
          });
          await this.broadcast({ type: 'reminder-fired', reminder: rem });
        }
      }
      if (changed) {
        s.reminders = s.reminders.filter((r) => !r.notified || (now - (r.notifiedAt || r.targetTime || 0) < 86400000));
        await this.save(s);
      }
    }

    try {
      await this.pollAndReply(s);
    } catch (e) {
      s = await this.load();
      s.runtime = { ...(s.runtime || {}), error: String(e?.message || e), lastAt: Date.now() };
      await this.save(s);
      await this.broadcast({ type: 'error', error: s.runtime.error });
    } finally {
      const cur = await this.load();
      if (cur.running) await this.reschedule();
    }
  }

  // ── 核心：拉消息 → 合并 → AI → 回复 → 推通知 ──

  async pollAndReply(s) {
    const res = await getUpdates(s.botToken, s.cursor, 6000);

    if (res.tokenExpired) {
      const st = await this.load();
      st.running = false;
      st.runtime = { ...(st.runtime || {}), error: 'bot_token 已过期，请重新扫码登录' };
      await this.save(st);
      await this.notify(st, { title: '微信 Bot 已掉线', body: st.runtime.error, tag: 'weixin-expired' });
      return;
    }

    if (res.cursor && res.cursor !== s.cursor) {
      const st = await this.load();
      st.cursor = res.cursor;
      await this.save(st);
      s.cursor = res.cursor;
    }

    let fresh = (res.messages || []).filter((m) => !this.isSeen(s, m));
    if (!fresh.length) return;

    const st2 = await this.load();
    for (const m of fresh) this.markSeen(st2, m);
    await this.save(st2);

    // 连发合并：COLLECT_MS 内再拉一次，把「在吗 / 睡了吗 / 喂」攒成一批
    if (fresh.length) {
      const merged = await this.collectMore(COLLECT_MS, s, fresh);
      if (merged.length > fresh.length) {
        const st3 = await this.load();
        for (const m of merged.slice(fresh.length)) this.markSeen(st3, m);
        await this.save(st3);
      }
      fresh = merged;
    }

    await this.handleBatch(fresh);
  }

  /** 在窗口内再拉一轮，合并同一批连发 */
  async collectMore(windowMs, s, first) {
    const batch = first.slice();
    const deadline = Date.now() + windowMs;
    try {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        const r = await getUpdates(s.botToken, s.cursor, 3000);
        if (r.cursor && r.cursor !== s.cursor) {
          const st = await this.load();
          st.cursor = r.cursor;
          await this.save(st);
          s.cursor = r.cursor;
        }
        const more = (r.messages || []).filter((m) => !this.isSeen(s, m));
        if (!more.length) break;   // 安静了，可以回
        batch.push(...more);
        // 已标记：防止下面 repeats
        const st2 = await this.load();
        for (const m of more) this.markSeen(st2, m);
        await this.save(st2);
      }
    } catch (e) { /* 拉取失败就用手上这批先回 */ }
    return batch;
  }

  async handleBatch(msgs) {
    const s = await this.load();
    if (!s.aiProfile || !s.char) return { ok: false, error: '未配置 AI 或角色' };

    const parts = [];
    const images = [];
    for (const m of msgs) {
      if (m.text) parts.push(m.text);
      if (m.hasImage && m.imageItem) {
        const got = await fetchImageDataUrl(m.imageItem);
        if (got?.dataUrl) images.push(got);
        parts.push('[对方发来一张图片]');
      }
      if (m.hasFile && m.fileItem) {
        const fileDetail = await fetchFileDetails(m.fileItem);
        if (fileDetail?.isImage && fileDetail.dataUrl) {
          images.push({ dataUrl: fileDetail.dataUrl, mime: fileDetail.mime });
          parts.push(`[对方发来图片文件「${fileDetail.fileName}」(${fileDetail.sizeStr})]`);
        } else if (fileDetail?.textContent) {
          parts.push(`[对方发来文件「${fileDetail.fileName}」(${fileDetail.sizeStr})，文件正文内容如下：\n${fileDetail.textContent}]`);
        } else {
          parts.push(`[对方发来文件「${fileDetail.fileName}」(${fileDetail.sizeStr})]`);
        }
      }
      if (m.hasVoice && !m.text) {
        parts.push('[对方发来一条语音]');
      }
      if (!m.text && !m.hasImage && !m.hasFile && !m.hasVoice && m.otherType) {
        parts.push('[对方发来一条暂不支持的消息]');
      }
    }
    if (!parts.length && !images.length) return { ok: false, error: '空消息' };

    const lastMsg = msgs[msgs.length - 1];
    let userText = joinIncoming(parts.length ? parts : (images.length ? ['[对方发来一张图片]'] : []));
    let userContent = buildUserContent(userText, images);

    // 记下回复凭据（供后面潜在的自发消息用）
    let st = await this.load();
    st.lastContext = { toUserId: lastMsg.fromUserId, contextToken: lastMsg.contextToken, at: Date.now() };
    st.lastUserId = lastMsg.fromUserId;
    st.lastContextToken = lastMsg.contextToken;
    st.cursor = s.cursor;
    await this.save(st);

    // ── 撤回与重说指令识别 ──
    const trimmedUser = userText.trim();
    const isRecallCmd = /^(撤回|撤销|撤回上一句|删掉刚才那句|忘掉刚才那句|删掉上一句|忘掉上一句|刚才那句不算|上一句不算)$/i.test(trimmedUser)
      || /撤回了一条消息/.test(trimmedUser);
    const isRegenCmd = /^(重说|重新说|重回|重新回答|重新回|重来|重写)$/i.test(trimmedUser);

    if (isRecallCmd) {
      st = await this.load();
      if (Array.isArray(st.history) && st.history.length >= 2) {
        st.history = st.history.slice(0, -2);
      } else {
        st.history = [];
      }
      await this.save(st);
      if (!/撤回了一条消息/.test(trimmedUser)) {
        await sendTextMessage({
          botToken: st.botToken,
          toUserId: lastMsg.fromUserId,
          contextToken: lastMsg.contextToken,
          text: '好，刚才那段我翻篇忘掉了，你重新跟我说吧'
        });
      }
      return { ok: true, recalled: true };
    }

    if (isRegenCmd) {
      st = await this.load();
      let prevUserText = '';
      if (Array.isArray(st.history) && st.history.length >= 2) {
        const lastUser = st.history[st.history.length - 2];
        if (lastUser && lastUser.role === 'user') {
          prevUserText = lastUser.content;
        }
        st.history = st.history.slice(0, -2);
        await this.save(st);
      }
      if (prevUserText) {
        userText = prevUserText;
        userContent = prevUserText;
      }
    }

    const system = buildWeixinSystem(st.char, st.recentBlock);
    // 按上下文预算安全构建 history，尽可能保留全部历史，同时避免超出模型上下文上限报错
    const rawHistory = st.history || [];
    let totalChars = 0;
    const history = [];
    for (let i = rawHistory.length - 1; i >= 0; i--) {
      const msg = rawHistory[i];
      const rawContent = typeof msg.content === 'string'
        ? msg.content.replace(/[\[【][\s:：\-_~^]*[\]】]/g, '').trim()
        : msg.content;
      const len = String(rawContent || '').length;
      if (totalChars + len > CONTEXT_BUDGET_CHARS && history.length >= 20) break;
      totalChars += len;
      history.unshift({ role: msg.role, content: rawContent });
    }
    const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: userContent }];

    // 「正在输入」，失败不影响主流程
    sendTyping({ botToken: st.botToken, toUserId: lastMsg.fromUserId, contextToken: lastMsg.contextToken })
      .catch(() => null);

    let raw;
    try {
      raw = await callAI(st.aiProfile, messages, {
        temperature: 0.85, max_tokens: 4096, maxRetries: 2,
      });
    } catch (e) {
      // 带图失败就剥图重试一次（有些模型不支持看图）
      if (Array.isArray(userContent)) {
        try {
          const textOnly = [
            { role: 'system', content: system },
            ...history,
            { role: 'user', content: userText },
          ];
          raw = await callAI(st.aiProfile, textOnly, { temperature: 0.85, max_tokens: 4096, maxRetries: 2 });
        } catch (e2) {
          return await this.fail(st, `AI 生成失败：${e2?.message || e2}`);
        }
      } else {
        return await this.fail(st, `AI 生成失败：${e?.message || e}`);
      }
    }

    // 解析小纸条与定时提醒指令
    const noteMatch = parseNoteDirective(raw);
    if (noteMatch.hasNote) {
      raw = noteMatch.cleanText;
      const resolved = resolveReminderTime(noteMatch.timeRaw);
      st = await this.load();
      st.reminders = st.reminders || [];
      st.charNotes = st.charNotes || [];

      // 严格去重：相同内容与相近设定时间（2分钟内）不重复存入，彻底避免一件事被连续添加多条
      const isDup = st.reminders.some(
        (r) => r.text === noteMatch.text && Math.abs((r.targetTime || 0) - (resolved.timestamp || 0)) < 120000
      );

      if (!isDup) {
        const newRem = {
          id: `remind-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          targetTime: resolved.timestamp,
          timeStr: resolved.formattedTime,
          text: noteMatch.text,
          charName: st.char?.name || '伴侣',
          toUserId: lastMsg.fromUserId,
          contextToken: lastMsg.contextToken,
          createdAt: Date.now(),
          notified: false
        };
        st.reminders.push(newRem);
        st.charNotes.push({
          id: Date.now() + Math.random(),
          text: noteMatch.text,
          timeStr: resolved.formattedTime,
          fromCharName: st.char?.name || '伴侣',
          createdAt: Date.now(),
          synced: false
        });
        await this.save(st);
        await this.broadcast({ type: 'note-added', note: newRem });
      }
    }

    const segments = parseReplySegments(raw).filter((s) => s.kind === 'text');
    if (!segments.length) return await this.fail(st, 'AI 返回的回复为空');

    // 逐条发出去（一条 = 一个气泡），条间留点打字节奏，跟安卓端口径一致
    const sentTexts = [];
    for (let i = 0; i < segments.length; i++) {
      const cleanVal = segments[i].value.replace(/[\[【][\s:：\-_~^]*[\]】]/g, '').trim();
      if (!cleanVal) continue;
      if (sentTexts.length > 0) await sleep(replyDelay(sentTexts[sentTexts.length - 1]));
      let ok = false;
      for (let retry = 0; retry < 2; retry++) {
        try {
          await sendTextMessage({
            botToken: st.botToken,
            toUserId: lastMsg.fromUserId,
            contextToken: lastMsg.contextToken,
            text: cleanVal,
          });
          ok = true;
          break;
        } catch (e) {
          if (retry === 0) {
            await sleep(350);
          } else {
            console.warn('[weixinBot] 第 ' + (i + 1) + ' 条发送失败：', e?.message || e);
          }
        }
      }
      if (ok) sentTexts.push(cleanVal);
    }
    if (!sentTexts.length) return await this.fail(st, `发送失败：${segments[0].value.slice(0, 20)}…`);
    const reply = sentTexts.join('\n');

    // 更新服务端上下文：把对方的话和回复都写进 history
    const nowTs = Date.now();
    st = await this.load();
    st.history = [
      ...(st.history || []),
      { role: 'user', content: userText, ts: nowTs - 2000, id: `wx_${nowTs - 2000}` },
      { role: 'assistant', content: reply, ts: nowTs, id: `wx_${nowTs}` },
    ].slice(-STORAGE_HISTORY_MAX);
    st.runtime = { lastAt: nowTs, error: '', replied: (st.runtime?.replied || 0) + 1 };
    await this.save(st);

    await this.broadcast({ type: 'replied', user: userText, reply, segments: sentTexts.length });
    await this.notify(st, {
      title: `${st.char?.name || 'TA'} 回你微信了`,
      body: reply.slice(0, 80),
      tag: 'weixin-reply',
    });
    return { ok: true, reply };
  }

  async fail(st, message) {
    const cur = await this.load();
    cur.runtime = { ...(cur.runtime || {}), error: message, lastAt: Date.now() };
    await this.save(cur);
    await this.broadcast({ type: 'error', error: message });
    return { ok: false, error: message };
  }

  // ── 去重 ──
  isSeen(s, m) {
    const id = String(m?.messageId || '').trim();
    if (!id) return false;
    const prev = s.seen?.[id];
    return prev !== undefined && Date.now() - prev < SEEN_TTL_MS;
  }
  markSeen(s, m) {
    const id = String(m?.messageId || '').trim();
    if (!id) return;
    if (!s.seen) s.seen = {};
    s.seen[id] = Date.now();
    // 顺手淘汰
    const keys = Object.keys(s.seen);
    if (keys.length > SEEN_MAX) {
      for (const k of keys) {
        if (Date.now() - s.seen[k] > SEEN_TTL_MS) delete s.seen[k];
      }
      const rest = Object.keys(s.seen);
      while (rest.length > SEEN_MAX) delete s.seen[rest.shift()];
    }
  }

  // ── 对外：配置 / 订阅 / SSE / 同步 ──

  async updateConfig(patch) {
    let s = await this.load();
    s = {
      ...s,
      ...patch,
      runtime: { ...(s.runtime || {}), error: '' },
    };
    await this.save(s);
    return { ok: true, running: s.running };
  }

  async addPushSub(subscription) {
    const s = await this.load();
    if (!s.pushSubs) s.pushSubs = [];
    const exists = s.pushSubs.some((x) => x.endpoint === subscription.endpoint);
    if (!exists) s.pushSubs.push(subscription);
    await this.save(s);
    return { ok: true, count: s.pushSubs.length };
  }

  async removePushSub(endpoint) {
    const s = await this.load();
    s.pushSubs = (s.pushSubs || []).filter((x) => x.endpoint !== endpoint);
    await this.save(s);
    return { ok: true, count: s.pushSubs.length };
  }

  /** 前端把本地聊天记录同步上来（以本地为准），顺便刷新「最近发生的事」 */
  async syncFromClient({ history, recentBlock, char, ackNotes }) {
    const s = await this.load();
    if (Array.isArray(ackNotes) && ackNotes.length) {
      s.charNotes = (s.charNotes || []).filter(n => !ackNotes.includes(n.id));
    }
    if (Array.isArray(history) && history.length) {
      s.history = history.slice(-STORAGE_HISTORY_MAX).map((m) => ({
        role: m.role === 'user' || m.isMe ? 'user' : 'assistant',
        content: String(m.content ?? m.text ?? '').slice(0, 2000),
      }));
    }
    if (typeof recentBlock === 'string') s.recentBlock = recentBlock;
    if (char && typeof char === 'object') s.char = { ...(s.char || {}), ...char };
    await this.save(s);
    return { ok: true, historyLen: s.history.length, notes: s.charNotes || [] };
  }

  async getState() {
    const s = await this.load();
    return {
      ok: true,
      running: s.running,
      botId: s.botId,
      cursor: s.cursor,
      history: s.history || [],
      notes: s.charNotes || [],
      reminders: s.reminders || [],
      runtime: s.runtime || {},
      hasChar: !!s.char,
      hasAI: !!s.aiProfile,
      pushCount: (s.pushSubs || []).length,
    };
  }

  // ── 通知 / 实时推送 ──

  async notify(s, payload) {
    const subs = s.pushSubs || [];
    if (!subs.length) return;
    for (const sub of subs.slice()) {
      const ok = await sendWebPush(this.env, sub, payload);
      if (!ok) {
        // 订阅失效（多半是用户清了浏览器数据）：直接丢弃，别反复重试
        const cur = await this.load();
        cur.pushSubs = (cur.pushSubs || []).filter((x) => x.endpoint !== sub.endpoint);
        await this.save(cur);
      }
    }
  }

  /** 注册 SSE 连接 */
  addListener(controller, encoder) {
    this.listeners.push({ controller, encoder });
  }

  broadcast(payload) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    const dead = [];
    for (const l of this.listeners) {
      try {
        l.controller.enqueue(l.encoder.encode(line));
      } catch (e) {
        dead.push(l);
      }
    }
    if (dead.length) {
      this.listeners = this.listeners.filter((l) => !dead.includes(l));
    }
  }

  // ── HTTP 入口（由 index.js 转发进来）──

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

    if (path === '/config' && request.method === 'POST') {
      const body = await request.json();
      const patch = {};
      if (body.botToken != null) patch.botToken = String(body.botToken);
      if (body.botId != null) patch.botId = String(body.botId);
      if (body.aiProfile) patch.aiProfile = body.aiProfile;
      if (body.char) patch.char = body.char;
      if (body.recentBlock != null) patch.recentBlock = String(body.recentBlock);
      const r = await this.updateConfig(patch);
      if (body.start) await this.start();
      return json(r);
    }

    if (path === '/start' && request.method === 'POST') return json(await this.start());
    if (path === '/stop' && request.method === 'POST') return json(await this.stop());
    if (path === '/state') return json(await this.getState());
    if (path === '/notes') {
      const s = await this.load();
      return json({ ok: true, notes: s.charNotes || [], reminders: s.reminders || [] });
    }

    if (path === '/push/subscribe' && request.method === 'POST') {
      const body = await request.json();
      return json(await this.addPushSub(body.subscription || body));
    }
    if (path === '/push/unsubscribe' && request.method === 'POST') {
      const body = await request.json();
      return json(await this.removePushSub(body.endpoint));
    }

    if (path === '/sync' && request.method === 'POST') {
      const body = await request.json();
      return json(await this.syncFromClient(body));
    }

    // SSE 实时流：前端开着网页时用它拿到即时动态
    if (path === '/stream') {
      const encoder = new TextEncoder();
      let ctrl;
      const stream = new ReadableStream({
        start: (c) => {
          ctrl = c;
          this.addListener(c, encoder);
          c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`));
        },
        cancel: () => { this.listeners = this.listeners.filter((l) => l.controller !== ctrl); },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    if (path === '/test-push' && request.method === 'POST') {
      const s = await this.load();
      await this.notify(s, { title: '来自小手机的测试', body: '推送通道正常，链接版可以后台提醒你了。', tag: 'weixin-test' });
      return json({ ok: true, subs: (s.pushSubs || []).length });
    }

    return json({ ok: false, message: 'not found' }, 404);
  }
}
