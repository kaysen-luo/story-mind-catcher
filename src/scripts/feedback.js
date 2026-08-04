// MVS-013 · v1.0 · 页内反馈工单
// 从 MVS-010 (marvis-loong-site/public/game-prd-tool.html) 1:1 移植的行为规格。
// 参照决策：mvs-010/decisions/20260803-feedback-ticket-mvp.md（第五节）
// Worker 契约：POST https://gpt-draft.luomycn.workers.dev/feedback
// 结构/交互/文案照搬，只在颜色 token 上用 013 既有 CSS 变量。

export const FEEDBACK_API_URL = 'https://gpt-draft.luomycn.workers.dev/feedback';
export const FEEDBACK_PRODUCT = 'mvs-013';
export const FEEDBACK_TOOL_VERSION = 'v1.0';
export const FEEDBACK_CONTENT_MAX = 500;
export const FEEDBACK_CONTACT_MAX = 100;
export const FEEDBACK_UA_MAX = 100;
// 副渠道（010 K师 2026-08-03 提供的腾讯问卷，全站复用）
export const FEEDBACK_FORM_URL = 'https://wj.qq.com/s2/27481407/glzc/';
export const FEEDBACK_ISSUE_URL = '';

// 从 navigator.userAgent 提取精简 UA："<浏览器> <大版本> / <OS>"
// 抽不出 → 'unknown'；总长限 FEEDBACK_UA_MAX。
export function feedbackParseUA(uaStr) {
  try {
    const ua = String(uaStr || '');
    if (!ua) return 'unknown';
    let browser = 'unknown';
    let m;
    if ((m = ua.match(/Edg\/(\d+)/))) browser = 'Edge ' + m[1];
    else if ((m = ua.match(/OPR\/(\d+)/))) browser = 'Opera ' + m[1];
    else if ((m = ua.match(/Firefox\/(\d+)/))) browser = 'Firefox ' + m[1];
    else if ((m = ua.match(/Chrome\/(\d+)/))) browser = 'Chrome ' + m[1];
    else if ((m = ua.match(/Version\/(\d+).*Safari/))) browser = 'Safari ' + m[1];
    let os = 'unknown';
    if (/Windows NT 10/.test(ua)) os = 'Windows 10';
    else if (/Windows NT 11/.test(ua)) os = 'Windows 11';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    let out = browser + ' / ' + os;
    if (out.length > FEEDBACK_UA_MAX) out = out.slice(0, FEEDBACK_UA_MAX);
    return out;
  } catch (e) { return 'unknown'; }
}

// 组装请求体：trim、字段裁剪到上限、product/version 固定为 mvs-013 常量。
// 返回 { ok:true, payload } 或 { ok:false, reason }。
// 不做网络调用，纯函数，方便单测。
export function buildFeedbackPayload({ content, contact, ua }) {
  const raw = String(content == null ? '' : content);
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  // 手动计数按「原始输入长度」判断——与 010 前端行为一致（textarea 里所见即所得）
  if (raw.length > FEEDBACK_CONTENT_MAX) return { ok: false, reason: 'too-long' };
  const c = String(contact == null ? '' : contact).trim();
  const contactOut = c.length > FEEDBACK_CONTACT_MAX ? c.slice(0, FEEDBACK_CONTACT_MAX) : c;
  const uaOut = feedbackParseUA(ua);
  return {
    ok: true,
    payload: {
      product: FEEDBACK_PRODUCT,
      version: FEEDBACK_TOOL_VERSION,
      content: trimmed,
      contact: contactOut,
      ua: uaOut,
    },
  };
}

// 4 位大写 HEX 之外的字符全部剔除，兜底 '----'
export function sanitizeTicketId(id) {
  const safe = String(id == null ? '' : id).replace(/[^0-9A-Za-z]/g, '');
  return safe || '----';
}

// 把 HTTP 结果翻译成用户可见的错误 key。
// - 429 → 'rate-limited'
// - 其它非 2xx / 网络错 → 'network'
export function classifyFeedbackError(status) {
  if (status === 429) return 'rate-limited';
  return 'network';
}

export const FEEDBACK_ERROR_TEXT = {
  'rate-limited': '发送太频繁了，请稍后再试',
  'network': '发送失败，请检查网络或稍后重试',
};
