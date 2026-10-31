// prompt.js —— 微信回复的 system 提示词（复刻自前端 weixinBridge.js）
//
// 口径必须与「赴约 / 普通聊天」一致，避免 OOC。
// char 结构是前端上传来的快照：{ name, persona, worldbookText, avatar }

export function buildWeixinSystem(char, recentBlock = '') {
  const personaHeader = char && (char.persona || char.name)
    ? `你叫 ${char.name || '对方'}。\n${char.persona || ''}`
    : '你是一个友好的聊天对象。';

  const worldbook = char?.worldbookText ? `\n\n【世界设定】\n${char.worldbookText}\n` : '';
  const recent = recentBlock ? `\n\n【刚刚发生的事（你自然知道这些）】\n${recentBlock}` : '';

  // ⚠️ 这一节必须与前端 weixinBridge.buildWeixinSystem 保持一致，否则会出现
  //    「安卓上分了好几条，网页版还是一个大气泡」的口径漂移。
  //    差别只在一处：Worker 端目前没有 CDN 加密上传能力，发不了表情包/语音/现画的图，
  //    所以**不在这里向模型承诺它做不到的事** —— 否则模型真写了指令行，
  //    服务端却又忽略它，用户就会看到「它什么都没回」。
  const sceneBlock = [
    '',
    '【当前场景】',
    '你现在正在用微信跟用户聊天（不是在小手机 App 里）。这里是你和用户在微信上的对话窗口。',
    timeBlock(),
    '不要用旁白、不要写动作描写、不要加书名号括起来的说明——微信里只说人话。',
    '不要暴露你是 AI 或模型，也不要提到「系统」「提示词」这类东西。',
    '',
    '【最重要：一行就是一条消息】',
    '你这次回复可以发好几条。**你每写一行，微信就会单独发出去一条消息**，',
    '对方看到的就是一个个分开的气泡，跟你平时打字聊天一模一样。',
    '所以请务必拆开写：一句话一行、问句单独一行、想补充的再另起一行。',
    '一般 1~3 行就够，最多 4 行。绝对不要把想说的全塞进一个大段落里。',
    '也不要自己加编号（不要写 1. 2. 3.），不要给每行加引号。',
    '如果用户发来的是图片，你会直接看到图片内容，正常针对画面说话就行，不用问「你发了什么」。',
  ].join('\n');

  return `${personaHeader}${worldbook}${recent}${sceneBlock}`;
}

// 当前时间提示块（复刻自前端）
export function timeBlock() {
  const now = new Date();
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  const d = now.getDate();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const h = now.getHours();
  const wd = days[now.getDay()];

  let mood = '';
  if (h >= 0 && h < 5) mood = '（深夜，人一般在睡觉或熬夜。如果对方这时候找你，可以有一点点在意或嗔怪的味道，但别刻意。）';
  else if (h < 8) mood = '（清晨，对方可能刚醒或还没睡。语气可以松一点。）';
  else if (h < 11) mood = '（上午）';
  else if (h < 14) mood = '（中午，可以自然带一句吃没吃饭之类的话。）';
  else if (h < 18) mood = '（下午）';
  else if (h < 23) mood = '（晚上，是聊天的好时段。）';
  else mood = '（夜里了，讲话可以更私密松弛一些。）';

  return `现在的真实时间：${y} 年 ${mo} 月 ${d} 日（星期${wd}）${hh}:${mm}。${mood}`;
}

/**
 * 模型可以在回复里穿插三种「非文字」动作，只有**独立成行**才认 ——
 * 否则正文里正常写个方括号就会被误伤。
 *
 *   [发送了表情: 名字]   发表情包
 *   [[voice: 要说的话]]  发语音条
 *   [[pic: 画图描述]]    现场生一张图
 *
 * ⚠️ Worker 端目前只发得出文字，非文字段会被发送环节跳过（不丢正文字的内容）。
 *    解析规则仍然与前端保持完全一致，等到 CDN 上传搬过来就能直接用。
 */
const EMOJI_LINE_SRC = '^[ \\t]*\\[\\s*发送了表情\\s*[:：]\\s*([^\\]\\n]{1,60})\\s*\\][ \\t]*$';
const VOICE_LINE_SRC = '^[ \\t]*\\[\\[\\s*voice\\s*[:：]\\s*([^\\]\\n]{1,500})\\s*\\]\\][ \\t]*$';
const PIC_LINE_SRC = '^[ \\t]*\\[\\[\\s*pic\\s*[:：]\\s*([^\\]\\n]{1,200})\\s*\\]\\][ \\t]*$';

const INLINE_MARKS = [
  /\[\s*发送了表情\s*[:：][^\]\n]{0,60}\]/g,
  /\[\[\s*voice\s*[:：][^\]\n]{0,500}\]\]/gi,
  /\[\[\s*pic\s*[:：][^\]\n]{0,200}\]\]/gi,
];

/** 单条消息的软长度上限，超过就再拆一次。真人微信一条很少超过这么多字 */
const MAX_LINE_CHARS = 60;
/** 一次回复最多发几条，防止模型失控在微信里刷屏 */
const MAX_REPLY_SEGMENTS = 5;

function collectLineMatches(raw, sourceRe, kind) {
  const s = String(raw || '');
  const re = new RegExp(sourceRe, 'gim');
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const v = String(m[1] || '').trim();
    if (v) out.push({ kind, value: v, index: m.index, length: m[0].length });
  }
  return out;
}

/** 清洗 AI 输出成适合发微信的纯文本 */
export function cleanWeixinReply(raw) {
  let s = String(raw || '');
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  s = s.replace(/<\/?(?:say|line|action|inner|os|text)>/gi, '');
  for (const re of INLINE_MARKS) s = s.replace(re, '');
  s = s.replace(/```[\s\S]*?```/g, '');
  s = s.replace(/^\s*#{1,6}\s*/gm, '');
  s = s.replace(/\*\*/g, '');
  s = s.replace(/^\s*[-*•·]\s+/gm, '');
  s = s.replace(/^\s*[\[（(]\d{1,2}:\d{2}(?::\d{2})?(?:\s*[A-Za-z\u4e00-\u9fa5]{1,3})?[\]）)]\s*/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 把模型的原始输出解析成有序节目单。
 * @returns {Array<{kind: string, value: string}>}
 */
export function parseReplySegments(raw) {
  const s = String(raw || '');
  const marks = [
    ...collectLineMatches(s, EMOJI_LINE_SRC, 'emoji'),
    ...collectLineMatches(s, VOICE_LINE_SRC, 'voice'),
    ...collectLineMatches(s, PIC_LINE_SRC, 'pic'),
  ].sort((a, b) => a.index - b.index);

  const segs = [];
  let cursor = 0;
  for (const mk of marks) {
    pushTextSegments(segs, s.slice(cursor, mk.index));
    segs.push({ kind: mk.kind, value: mk.value });
    cursor = mk.index + mk.length;
  }
  pushTextSegments(segs, s.slice(cursor));
  return capSegments(segs);
}

function pushTextSegments(segs, chunk) {
  const cleaned = cleanWeixinReply(chunk);
  if (!cleaned) return;
  for (const line of cleaned.split(/\n+/)) {
    const t = line.trim();
    if (!t) continue;
    for (const piece of splitLongLine(t)) segs.push({ kind: 'text', value: piece });
  }
}

function splitLongLine(line) {
  if (line.length <= MAX_LINE_CHARS) return [line];

  const byPunct = [];
  let buf = '';
  for (const ch of line) {
    buf += ch;
    if (/[。！？!?…；;]/.test(ch) && buf.length >= MAX_LINE_CHARS * 0.6) {
      byPunct.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) byPunct.push(buf.trim());

  const out = [];
  for (const piece of byPunct) {
    if (piece.length <= MAX_LINE_CHARS * 1.5) { out.push(piece); continue; }
    for (let i = 0; i < piece.length; i += MAX_LINE_CHARS) {
      out.push(piece.slice(i, i + MAX_LINE_CHARS));
    }
  }
  return out.length ? out : [line];
}

function capSegments(segs) {
  if (segs.length <= MAX_REPLY_SEGMENTS) return segs;
  const head = segs.slice(0, MAX_REPLY_SEGMENTS - 1);
  const texts = segs.slice(MAX_REPLY_SEGMENTS - 1)
    .filter((s) => s.kind === 'text')
    .map((s) => s.value);
  if (texts.length) head.push({ kind: 'text', value: texts.join(' ') });
  return head;
}

/** 把多模态内容拼成 callAI 能吃的格式（有图给数组，没图给字符串） */
export function buildUserContent(userText, images) {
  if (!images || !images.length) return userText;
  const parts = [];
  for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  const text = String(userText).replace(/\[对方发来一张图片\]/g, '[图片见上]');
  parts.push({ type: 'text', text });
  return parts;
}

/** 把多条消息拼成一段 user 输入（连发合并） */
export function joinIncoming(parts) {
  return parts.length === 1 ? parts[0] : parts.join('\n');
}
