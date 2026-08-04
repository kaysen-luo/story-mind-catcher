// MVS-013 · v1.0 · feedback 模块单测
// 用法：node --test tests/feedback.test.mjs
// 覆盖：
//   1. 请求体组装主路径（product=mvs-013 / version / trim / UA 精简）
//   2. 字段裁剪（contact 超 100）
//   3. 异常路径：空内容 / 全空白 / 超长
//   4. 边界：正好 500 字通过
//   5. UA 解析：主流浏览器 + OS + 空 UA
//   6. 工单号 sanitize / 错误分类

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEEDBACK_API_URL,
  FEEDBACK_PRODUCT,
  FEEDBACK_TOOL_VERSION,
  FEEDBACK_CONTENT_MAX,
  FEEDBACK_CONTACT_MAX,
  buildFeedbackPayload,
  feedbackParseUA,
  sanitizeTicketId,
  classifyFeedbackError,
  FEEDBACK_ERROR_TEXT,
} from '../src/scripts/feedback.js';

test('常量：product 必须是 mvs-013（白名单一致）', () => {
  assert.equal(FEEDBACK_PRODUCT, 'mvs-013');
  assert.equal(FEEDBACK_TOOL_VERSION, 'v1.0');
  assert.equal(FEEDBACK_CONTENT_MAX, 500);
  assert.equal(FEEDBACK_CONTACT_MAX, 100);
  assert.equal(FEEDBACK_API_URL, 'https://gpt-draft.luomycn.workers.dev/feedback');
});

test('buildFeedbackPayload：主路径 — trim + product/version 常量注入 + UA 精简', () => {
  const r = buildFeedbackPayload({
    content: '  遇到了一个 bug  ',
    contact: '  wx: abc  ',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, {
    product: 'mvs-013',
    version: 'v1.0',
    content: '遇到了一个 bug',
    contact: 'wx: abc',
    ua: 'Chrome 131 / macOS',
  });
});

test('buildFeedbackPayload：异常 — 空内容', () => {
  const r = buildFeedbackPayload({ content: '', contact: '', ua: '' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('buildFeedbackPayload：异常 — 全空白内容', () => {
  const r = buildFeedbackPayload({ content: '   \n\t  ', contact: '', ua: '' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('buildFeedbackPayload：异常 — 超长内容（501 字被拒）', () => {
  const long = 'a'.repeat(501);
  const r = buildFeedbackPayload({ content: long, contact: '', ua: '' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-long');
});

test('buildFeedbackPayload：边界 — 正好 500 字通过', () => {
  const exactly = 'a'.repeat(500);
  const r = buildFeedbackPayload({ content: exactly, contact: '', ua: '' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.content.length, 500);
});

test('buildFeedbackPayload：contact 超 100 字被裁到 100', () => {
  const longContact = 'x'.repeat(150);
  const r = buildFeedbackPayload({ content: 'hello', contact: longContact, ua: '' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.contact.length, 100);
});

test('buildFeedbackPayload：contact / ua 缺省 → 空串 / unknown', () => {
  const r = buildFeedbackPayload({ content: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.contact, '');
  assert.equal(r.payload.ua, 'unknown');
});

test('feedbackParseUA：主流浏览器 / OS 组合', () => {
  // Chrome / macOS
  assert.equal(
    feedbackParseUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
    'Chrome 131 / macOS'
  );
  // Firefox / Windows 10
  assert.equal(
    feedbackParseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'),
    'Firefox 120 / Windows 10'
  );
  // Safari / iPhone UA — 注意：iPhone UA 里含 'Mac OS X'，而 010 的 OS 判断顺序是 macOS 在 iOS 前面，
  // 所以 iPhone 会被识别成 macOS。这是 1:1 移植的既有行为，不修，保证与 010 表现一致。
  assert.equal(
    feedbackParseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'),
    'Safari 17 / macOS'
  );
  // Edge 优先于 Chrome
  assert.equal(
    feedbackParseUA('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'),
    'Edge 131 / Windows 10'
  );
  // Android Chrome
  assert.equal(
    feedbackParseUA('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'),
    'Chrome 125 / Android'
  );
});

test('feedbackParseUA：空 / 非法输入 → unknown', () => {
  assert.equal(feedbackParseUA(''), 'unknown');
  assert.equal(feedbackParseUA(null), 'unknown');
  assert.equal(feedbackParseUA(undefined), 'unknown');
  assert.equal(feedbackParseUA('some-random-string'), 'unknown / unknown');
});

test('sanitizeTicketId：非法字符剔除，兜底 ----', () => {
  assert.equal(sanitizeTicketId('A3F7'), 'A3F7');
  assert.equal(sanitizeTicketId('<script>'), 'script');
  assert.equal(sanitizeTicketId(''), '----');
  assert.equal(sanitizeTicketId(null), '----');
  assert.equal(sanitizeTicketId('!@#$%'), '----');
});

test('classifyFeedbackError / FEEDBACK_ERROR_TEXT：429 → rate-limited；其它 → network', () => {
  assert.equal(classifyFeedbackError(429), 'rate-limited');
  assert.equal(classifyFeedbackError(500), 'network');
  assert.equal(classifyFeedbackError(0), 'network');
  assert.equal(FEEDBACK_ERROR_TEXT['rate-limited'], '发送太频繁了，请稍后再试');
  assert.equal(FEEDBACK_ERROR_TEXT['network'], '发送失败，请检查网络或稍后重试');
});
