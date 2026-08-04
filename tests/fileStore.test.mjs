// MVS-013 · v1.1 · fileStore.js unit tests
// 用法：`node --test tests/fileStore.test.mjs`（或 `node --test tests/`）
// 纯逻辑（serialize/parse/suggestFileName/isSupported）直接测；
// picker/FS API 部分用 mock window / mock handle 覆盖主路径 + 异常路径。
//
// 覆盖：
//   1. serializeSmc 顶层字段完整 + 可 round-trip
//   2. parseSmc 主路径成功
//   3. parseSmc 异常：非 JSON / 非对象 / app 不匹配 / formatVersion 不支持 / data 缺失
//   4. suggestFileName：正常书名 / 空标题回退 / 非法字符清洗 / 超长截断
//   5. isSupported：能力检测 true/false
//   6. pickOpenFile / pickSaveFile：mock window 成功 + 用户取消(AbortError) + 不支持抛错
//   7. readHandleText / writeHandleText：mock handle 主路径 + 无效句柄抛错
//   8. queryHandlePermission / requestHandlePermission：granted / denied / 无方法降级

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as fs from '../src/scripts/fileStore.js';

const SAMPLE_DATA = {
  project: { title: '三体设定', oneLineStory: '文明黑暗森林' },
  world: { era: '未来' },
  characters: [{ name: '罗辑' }],
  chapters: [{ number: 1, title: '第一章' }],
};

// ---- 1. serializeSmc ----
test('serializeSmc 顶层字段完整', () => {
  const text = fs.serializeSmc(SAMPLE_DATA, { exportedAt: '2026-07-30T00:00:00.000Z' });
  const doc = JSON.parse(text);
  assert.equal(doc.formatVersion, '1.0');
  assert.equal(doc.app, 'story-mind-catcher');
  assert.equal(doc.exportedAt, '2026-07-30T00:00:00.000Z');
  assert.deepEqual(doc.data, SAMPLE_DATA);
});

test('serializeSmc 空 data 兜底为 {}', () => {
  const doc = JSON.parse(fs.serializeSmc(null));
  assert.deepEqual(doc.data, {});
  assert.ok(doc.exportedAt); // 自动生成 ISO
});

test('serialize → parse round-trip 一致', () => {
  const text = fs.serializeSmc(SAMPLE_DATA);
  const res = fs.parseSmc(text);
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, SAMPLE_DATA);
});

// ---- 2/3. parseSmc ----
test('parseSmc 主路径成功', () => {
  const text = JSON.stringify({ formatVersion: '1.0', app: 'story-mind-catcher', exportedAt: 'x', data: { a: 1 } });
  const res = fs.parseSmc(text);
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { a: 1 });
  assert.equal(res.formatVersion, '1.0');
});

test('parseSmc 非 JSON 失败', () => {
  const res = fs.parseSmc('{ not json');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'invalid-json');
});

test('parseSmc 非对象（数组）失败', () => {
  const res = fs.parseSmc('[1,2,3]');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'not-object');
});

test('parseSmc app 不匹配失败', () => {
  const text = JSON.stringify({ formatVersion: '1.0', app: 'other-app', data: {} });
  const res = fs.parseSmc(text);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'wrong-app');
});

test('parseSmc formatVersion 不支持（老/新版本）失败', () => {
  const text = JSON.stringify({ formatVersion: '9.9', app: 'story-mind-catcher', data: {} });
  const res = fs.parseSmc(text);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'unsupported-version');
});

test('parseSmc data 缺失失败', () => {
  const text = JSON.stringify({ formatVersion: '1.0', app: 'story-mind-catcher' });
  const res = fs.parseSmc(text);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no-data');
});

// ---- 4. suggestFileName ----
test('suggestFileName 正常书名', () => {
  assert.equal(fs.suggestFileName('三体设定'), '三体设定.smc');
});

test('suggestFileName 空标题回退', () => {
  assert.equal(fs.suggestFileName(''), '无题项目.smc');
  assert.equal(fs.suggestFileName('   '), '无题项目.smc');
  assert.equal(fs.suggestFileName(null), '无题项目.smc');
});

test('suggestFileName 清洗非法字符', () => {
  assert.equal(fs.suggestFileName('三体/设定:v1?'), '三体设定v1.smc');
});

test('suggestFileName 全非法字符回退', () => {
  assert.equal(fs.suggestFileName('///:::'), '无题项目.smc');
});

test('suggestFileName 超长截断到 80', () => {
  const long = 'a'.repeat(200);
  const name = fs.suggestFileName(long);
  assert.equal(name, 'a'.repeat(80) + '.smc');
});

// ---- 5. isSupported ----
test('isSupported true 当两 API 都在', () => {
  const win = { showOpenFilePicker: () => {}, showSaveFilePicker: () => {} };
  assert.equal(fs.isSupported(win), true);
});

test('isSupported false 当缺 API', () => {
  assert.equal(fs.isSupported({}), false);
  assert.equal(fs.isSupported({ showOpenFilePicker: () => {} }), false); // 缺 save
  assert.equal(fs.isSupported(undefined), false);
});

// ---- 6. pickOpenFile / pickSaveFile ----
test('pickOpenFile 成功返回 handle', async () => {
  const fakeHandle = { name: 'a.smc' };
  const win = { showOpenFilePicker: async () => [fakeHandle] };
  const h = await fs.pickOpenFile(win);
  assert.equal(h, fakeHandle);
});

test('pickOpenFile 用户取消(AbortError)返回 null', async () => {
  const win = { showOpenFilePicker: async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; } };
  const h = await fs.pickOpenFile(win);
  assert.equal(h, null);
});

test('pickOpenFile 不支持时抛错', async () => {
  await assert.rejects(() => fs.pickOpenFile({}), /不支持/);
});

test('pickSaveFile 成功返回 handle 并传 suggestedName', async () => {
  let captured;
  const fakeHandle = { name: '三体设定.smc' };
  const win = { showSaveFilePicker: async (opts) => { captured = opts; return fakeHandle; } };
  const h = await fs.pickSaveFile('三体设定.smc', win);
  assert.equal(h, fakeHandle);
  assert.equal(captured.suggestedName, '三体设定.smc');
});

test('pickSaveFile 用户取消返回 null', async () => {
  const win = { showSaveFilePicker: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; } };
  assert.equal(await fs.pickSaveFile('a.smc', win), null);
});

// ---- 7. read/write handle ----
test('readHandleText 读取文本', async () => {
  const handle = { getFile: async () => ({ text: async () => 'hello' }) };
  assert.equal(await fs.readHandleText(handle), 'hello');
});

test('readHandleText 无效句柄抛错', async () => {
  await assert.rejects(() => fs.readHandleText(null), /无效的文件句柄/);
});

test('writeHandleText 写入并关闭 writable', async () => {
  let written = '', closed = false;
  const handle = {
    createWritable: async () => ({
      write: async (t) => { written = t; },
      close: async () => { closed = true; },
    }),
  };
  await fs.writeHandleText(handle, 'payload');
  assert.equal(written, 'payload');
  assert.equal(closed, true);
});

test('writeHandleText 即使 write 抛错也关闭 writable', async () => {
  let closed = false;
  const handle = {
    createWritable: async () => ({
      write: async () => { throw new Error('disk full'); },
      close: async () => { closed = true; },
      abort: async () => {},
    }),
  };
  await assert.rejects(() => fs.writeHandleText(handle, 'x'), /disk full/);
});

// ---- 7b. 阻塞-1：原子写入保护（写失败→abort→原文件不损）----
// stateful mock：模拟 FSA swap 语义——write 写进 swap，close 才提交到 committed，
// abort 丢弃 swap（committed 不变）。
function makeSwapFileMock(initial) {
  const state = { committed: initial, swap: null, aborted: false };
  const handle = {
    createWritable: async (opts) => {
      // keepExistingData:true 时 swap 从 committed 拷贝起步；否则空。
      state.swap = (opts && opts.keepExistingData) ? state.committed : '';
      return {
        write: async (t) => { state.swap = t; },
        truncate: async () => {},
        close: async () => { state.committed = state.swap; state.swap = null; },
        abort: async () => { state.aborted = true; state.swap = null; },
      };
    },
  };
  return { handle, state };
}

test('阻塞-1 写成功：committed 被新内容替换', async () => {
  const { handle, state } = makeSwapFileMock('OLD-CONTENT');
  await fs.writeHandleText(handle, 'NEW-CONTENT');
  assert.equal(state.committed, 'NEW-CONTENT');
});

test('阻塞-1 write 中途抛错：原文件未被截断，已 abort', async () => {
  const { state } = makeSwapFileMock('IMPORTANT-DATA');
  const handle = {
    createWritable: async () => ({
      write: async () => { throw new Error('disk full'); },
      close: async () => { throw new Error('should not commit'); },
      abort: async () => { state.aborted = true; state.swap = null; },
    }),
  };
  await assert.rejects(() => fs.writeHandleText(handle, 'HALF'), /disk full/);
  // 原 committed 未变（未被截空），abort 被调用
  assert.equal(state.committed, 'IMPORTANT-DATA');
  assert.equal(state.aborted, true);
});

test('阻塞-1 close 抛错：abort 兼顶，原文件未损', async () => {
  const state = { committed: 'ORIG', aborted: false };
  const handle = {
    createWritable: async () => ({
      write: async () => {},
      close: async () => { throw new Error('commit failed'); },
      abort: async () => { state.aborted = true; },
    }),
  };
  await assert.rejects(() => fs.writeHandleText(handle, 'x'), /commit failed/);
  assert.equal(state.committed, 'ORIG');
  assert.equal(state.aborted, true);
});

test('阻塞-1 无 abort 方法的退化实现不抛未捕获错', async () => {
  const handle = {
    createWritable: async () => ({
      write: async () => { throw new Error('boom'); },
      close: async () => {},
    }),
  };
  await assert.rejects(() => fs.writeHandleText(handle, 'x'), /boom/);
});

test('writeHandleText 传 mode:exclusive（可被 mock 捕获）', async () => {
  let capturedOpts;
  const handle = {
    createWritable: async (opts) => { capturedOpts = opts; return {
      write: async () => {}, close: async () => {}, abort: async () => {},
    }; },
  };
  await fs.writeHandleText(handle, 'x');
  assert.equal(capturedOpts && capturedOpts.mode, 'exclusive');
});

test('writeHandleText createWritable(exclusive) 抛错时退化到默认', async () => {
  let calls = 0;
  const handle = {
    createWritable: async (opts) => {
      calls++;
      if (opts && opts.mode === 'exclusive') throw new Error('mode unsupported');
      return { write: async () => {}, close: async () => {}, abort: async () => {} };
    },
  };
  await fs.writeHandleText(handle, 'x'); // 不抛错
  assert.equal(calls, 2); // 先 exclusive 失败，再默认成功
});

test('writeHandleText 无效句柄抛错', async () => {
  await assert.rejects(() => fs.writeHandleText({}, 'x'), /无效的文件句柄/);
});

// ---- 8. permission ----
test('queryHandlePermission granted', async () => {
  const handle = { queryPermission: async () => 'granted' };
  assert.equal(await fs.queryHandlePermission(handle, true), 'granted');
});

test('queryHandlePermission 无方法降级 denied', async () => {
  assert.equal(await fs.queryHandlePermission({}, true), 'denied');
  assert.equal(await fs.queryHandlePermission(null, true), 'denied');
});

test('requestHandlePermission granted', async () => {
  const handle = { requestPermission: async () => 'granted' };
  assert.equal(await fs.requestHandlePermission(handle, true), 'granted');
});

test('requestHandlePermission 抛错时降级 denied', async () => {
  const handle = { requestPermission: async () => { throw new Error('no gesture'); } };
  assert.equal(await fs.requestHandlePermission(handle, true), 'denied');
});
