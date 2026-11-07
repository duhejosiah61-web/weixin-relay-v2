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
    '根据你的角色人设自然表达；除非你的人设设定本身就是 AI / 仿生人 / 虚拟伴侣，否则不要无故破坏沉浸感自称模型，也绝不要提及「系统」「提示词」等幕后概念。',
    '',
    '【最重要：一行就是一条消息】',
    '你这次回复可以发好几条。**你每写一行，微信就会单独发出去一条消息**，',
    '对方看到的就是一个个分开的小气泡，跟你平时打字聊天一模一样。',
    '为了让对方在手机和平板分屏小屏下看得很舒服，每行请保持在 8~18 个字以内的自然短句，严禁写超长单句。',
    '请务必拆开写：一句话一行、问句单独一行、想补充的再另起一行。',
    '一般 1~4 行，最多 6 行。绝对不要把想说的全塞进一个大段落里。',
    '也不要自己加编号（不要写 1. 2. 3.），不要给每行加引号。',
    '如果用户发来的是图片，你会直接看到图片内容，正常针对画面说话就行，不用问「你发了什么」。',
    '',
    '【关于小纸条与定时提醒】',
    '当对方让你到点提醒她做某件事（例如：几点提醒我、几点前叫我、提醒我吃药、开会等）、或者你们约定几点干什么、或者你想主动为她记下一份备忘时，',
    '请在正常回复之外，单独起一行写：',
    '[小纸条: 时间 | 待办内容]',
    '例如：[小纸条: 15:00 | 下午部门例会，带笔记本] 或 [小纸条: 20:30 | 记得准时吃药] 或 [小纸条: 30分钟后 | 出门拿快递]',
    '这一行会被系统自动转为她「陪伴」App 待办清单里的实体小纸条，并且系统会在设定的时间到达时，自动由你向她发消息主动提醒！用户微信窗口不会看到方括号指令本身。',
  ].join('\n');

  return `${personaHeader}${worldbook}${recent}${sceneBlock}`;
}

// 当前时间提示块（转为东八区北京时间，杜绝 Cloudflare UTC 零时区导致晚上变中午）
export function timeBlock() {
  const utcNow = new Date();
  // 加上 8 小时转为北京时间
  const bjTime = new Date(utcNow.getTime() + 8 * 3600 * 1000);
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const y = bjTime.getUTCFullYear();
  const mo = bjTime.getUTCMonth() + 1;
  const d = bjTime.getUTCDate();
  const hh = String(bjTime.getUTCHours()).padStart(2, '0');
  const mm = String(bjTime.getUTCMinutes()).padStart(2, '0');
  const h = bjTime.getUTCHours();
  const wd = days[bjTime.getUTCDay()];

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
 * 模型可以在回复里穿插动作指令：
 *   [发送了表情: 名字]   发表情包
 *   [[voice: 要说的话]]  发语音条
 *   [[pic: 画图描述]]    现场生一张图
 *   [小纸条: 时间 | 内容] 小纸条待办
 */
const EMOJI_LINE_SRC = '^[ \\t]*\\[\\s*发送了表情\\s*[:：]\\s*([^\\]\\n]{1,60})\\s*\\][ \\t]*$';
const VOICE_LINE_SRC = '^[ \\t]*\\[\\[\\s*voice\\s*[:：]\\s*([^\\]\\n]{1,500})\\s*\\]\\][ \\t]*$';
const PIC_LINE_SRC = '^[ \\t]*\\[\\[\\s*pic\\s*[:：]\\s*([^\\]\\n]{1,200})\\s*\\]\\][ \\t]*$';

const INLINE_MARKS = [
  /\[\s*发送了表情\s*[:：][^\]\n]{0,60}\]/g,
  /\[\[\s*voice\s*[:：][^\]\n]{0,500}\]\]/gi,
  /\[\[\s*pic\s*[:：][^\]\n]{0,200}\]\]/gi,
  /\[(?:小纸条|提醒|待办|备忘)\s*[:：][^\]\n]*\]/gi,
];

const NOTE_DIRECTIVE_REGEX = /\[(?:小纸条|提醒|待办|备忘)\s*[:：]\s*(?:([^|｜\n\]]+)\s*[|｜]\s*)?([^\]]+)\]/i;
const ALL_NOTE_DIRECTIVES_REGEX = /\[(?:小纸条|提醒|待办|备忘)\s*[:：][^\]]*\]/gi;

/** 单条消息的软长度上限：适配平板分屏/小窗，超过 18 字自动沿标点拆成小气泡，杜绝微信右侧切字 */
const MAX_LINE_CHARS = 18;
/** 一次回复最多发几条，防止模型失控在微信里刷屏 */
const MAX_REPLY_SEGMENTS = 8;

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

export function parseNoteDirective(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { hasNote: false, timeRaw: '', text: '', cleanText: '' };
  }
  const match = rawText.match(NOTE_DIRECTIVE_REGEX);
  const cleanText = rawText.replace(ALL_NOTE_DIRECTIVES_REGEX, '').trim();
  if (!match) {
    return { hasNote: false, timeRaw: '', text: '', cleanText };
  }
  const part1 = (match[1] || '').trim();
  const part2 = (match[2] || '').trim();
  let timeRaw = '';
  let noteText = '';
  if (part1 && part2) {
    timeRaw = part1;
    noteText = part2;
  } else if (part2) {
    const leadingTimeMatch = part2.match(/^((?:\d{1,2}:\d{2})|(?:(?:今天|明天|后天)?\s*(?:上午|下午|晚上)?\s*\d{1,2}(?:[:点]\d{0,2})?(?:分)?)|(?:\d+\s*(?:分钟|小时)后))\s+(.+)$/);
    if (leadingTimeMatch) {
      timeRaw = leadingTimeMatch[1].trim();
      noteText = leadingTimeMatch[2].trim();
    } else {
      noteText = part2;
    }
  }
  return { hasNote: !!noteText, timeRaw, text: noteText, cleanText };
}

export function resolveReminderTime(timeStr, baseDate = new Date()) {
  const now = new Date(baseDate);
  if (!timeStr || typeof timeStr !== 'string' || !timeStr.trim()) {
    return { targetDate: now, timestamp: now.getTime(), formattedTime: '', isUpcoming: false };
  }
  const str = timeStr.trim().toLowerCase();
  let target = new Date(now.getTime());
  let formattedTime = '';

  const halfHourMatch = str.match(/^(?:半小时|半个?小时)后$/);
  if (halfHourMatch) {
    target = new Date(now.getTime() + 30 * 60 * 1000);
    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    formattedTime = `30分钟后 (${hh}:${mm})`;
    return { targetDate: target, timestamp: target.getTime(), formattedTime, isUpcoming: true };
  }

  const minMatch = str.match(/^(\d+)\s*(?:分钟|分)后$/);
  if (minMatch) {
    const mins = parseInt(minMatch[1], 10);
    target = new Date(now.getTime() + mins * 60 * 1000);
    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    formattedTime = `${mins}分钟后 (${hh}:${mm})`;
    return { targetDate: target, timestamp: target.getTime(), formattedTime, isUpcoming: true };
  }

  const hourMatch = str.match(/^(\d+(?:\.\d+)?)\s*(?:个?半?)?小时后$/);
  if (hourMatch) {
    const hours = parseFloat(hourMatch[1]);
    const extraHalf = str.includes('半') && !str.includes('.5') ? 0.5 : 0;
    const totalHours = hours + extraHalf;
    target = new Date(now.getTime() + totalHours * 3600 * 1000);
    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    formattedTime = `${totalHours}小时后 (${hh}:${mm})`;
    return { targetDate: target, timestamp: target.getTime(), formattedTime, isUpcoming: true };
  }

  let dayOffset = 0;
  let dayLabel = '今日';
  if (str.includes('明天') || str.includes('次日')) {
    dayOffset = 1;
    dayLabel = '明天';
  } else if (str.includes('后天')) {
    dayOffset = 2;
    dayLabel = '后天';
  }
  target.setDate(target.getDate() + dayOffset);

  let hour = -1;
  let minute = 0;
  const colonMatch = str.match(/(\d{1,2})[:：](\d{1,2})/);
  if (colonMatch) {
    hour = parseInt(colonMatch[1], 10);
    minute = parseInt(colonMatch[2], 10);
  } else {
    const pointMatch = str.match(/(\d{1,2})\s*点(?:半|(\d{1,2})分?)?/);
    if (pointMatch) {
      hour = parseInt(pointMatch[1], 10);
      if (str.includes('半')) {
        minute = 30;
      } else if (pointMatch[2]) {
        minute = parseInt(pointMatch[2], 10);
      } else {
        minute = 0;
      }
    }
  }

  if (hour >= 0) {
    if ((str.includes('下午') || str.includes('傍晚') || str.includes('晚上') || str.includes('夜里') || str.includes('今晚')) && hour < 12) {
      hour += 12;
    } else if ((str.includes('上午') || str.includes('早上') || str.includes('早晨')) && hour === 12) {
      hour = 0;
    }
    target.setHours(hour, minute, 0, 0);
    if (dayOffset === 0 && target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
      dayLabel = '明天';
    }
    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    formattedTime = `${dayLabel} ${hh}:${mm}`;
    return {
      targetDate: target,
      timestamp: target.getTime(),
      formattedTime,
      isUpcoming: target.getTime() > now.getTime()
    };
  }

  const parsed = new Date(timeStr);
  if (!isNaN(parsed.getTime())) {
    const hh = String(parsed.getHours()).padStart(2, '0');
    const mm = String(parsed.getMinutes()).padStart(2, '0');
    return {
      targetDate: parsed,
      timestamp: parsed.getTime(),
      formattedTime: `${hh}:${mm}`,
      isUpcoming: parsed.getTime() > now.getTime()
    };
  }

  return { targetDate: now, timestamp: now.getTime(), formattedTime: timeStr, isUpcoming: false };
}

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
  const out = [];
  let rest = line;
  const breakChars = ['，', '。', '！', '？', '；', '、', ',', '!', '?', ';', ' '];
  while (rest.length > MAX_LINE_CHARS) {
    let cut = -1;
    // 优先在 8 到 MAX_LINE_CHARS 字之间寻找标点符号断句
    for (let i = Math.min(MAX_LINE_CHARS, rest.length - 1); i >= 8; i--) {
      if (breakChars.includes(rest[i])) { cut = i + 1; break; }
    }
    // 如果没有找到标点符号，检查是否正好在括号/颜文字附近
    if (cut <= 0) {
      // 检查是否有左括号或表情符号，如果在合理位置，优先在括号前切断，避免撕裂颜文字
      const bracketIdx = rest.slice(0, MAX_LINE_CHARS).search(/[\[\(\（]/);
      if (bracketIdx >= 8) {
        cut = bracketIdx;
      } else {
        cut = MAX_LINE_CHARS;
      }
    }
    const piece = rest.slice(0, cut).trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) {
    // 如果剩余的尾巴非常短（例如 <= 4 个字符且主要是标点/符号/颜文字尾巴），避免单独发一个孤立小气泡，合并到上一句
    if (out.length > 0 && rest.length <= 4 && !/[\u4e00-\u9fa5]{2,}/.test(rest)) {
      out[out.length - 1] = `${out[out.length - 1]}${rest}`;
    } else {
      out.push(rest);
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

export function buildUserContent(userText, images) {
  if (!images || !images.length) return userText;
  const parts = [];
  for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  const text = String(userText).replace(/\[对方发来一张图片\]/g, '[图片见上]');
  parts.push({ type: 'text', text });
  return parts;
}

export function joinIncoming(parts) {
  return parts.length === 1 ? parts[0] : parts.join('\n');
}
