// MVS-013 · v1.1 · app.js 文件层契约测试（阻塞-1/2 + 建议-1/2 的 app 层行为）
// 用法：`node --test tests/appFile.test.mjs`
//
// 覆盖 code review 点名的三大盲区（此前零覆盖）：
//   1. 写失败 → 持久错误告警 fileError 被触发（阻塞-1 fail-loud）
//   2. 并发写 → 串行锁：同一时刻只有一个 createWritable 在途，后来的合并为最新一次（建议-2）
//   3. 切档 → 强制解绑 fileHandle（建议-1，防写错档）
//   4. 权限写入途中被撤销 → 标记需重连 + 持久告警，不静默（阻塞-1）
//
// 说明：直接实例化 createApp() 返回的 store，跳过 init()（避开 DOM/localStorage 深依赖），
// 只给文件方法所需的最小状态。用全局 mock 桩掉 localStorage / IndexedDB handle 桥。

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- 全局桩：localStorage / window / timers 由 node 提供 ----
globalThis.localStorage = {
  _m: {},
  getItem(k) { return k in this._m ? this._m[k] : null; },
  setItem(k, v) { this._m[k] = String(v); },
  removeItem(k) { delete this._m[k]; },
};

const { createApp } = await import('../src/scripts/app.js');

// 造一个最小可用 store，跳过 init，只装文件方法要用的状态。
function makeStore() {
  const app = createApp();
  app.fileSupported = true;
  app.currentProjectId = 'p1';
  app.data = app.defaultData();
  app.data.project.title = '测试书';
  // 桩掉会触碰 DOM/timer 抖动的方法
  app.showToast = function (m) { this._lastToast = m; };
  app.saveProjectData = function () { this._lsSaved = (this._lsSaved || 0) + 1; };
  app.rescanAsks = function () {};
  app._persistFileHandle = function () {};
  app.newChapter = function (n) { return { id: 'c' + n, number: n, title: '', fragments: [] }; };
  return app;
}

// 造一个 stateful 文件 handle mock（swap 语义）。
function makeHandle(opts = {}) {
  const state = { committed: opts.initial || '', writeCalls: 0, concurrentPeak: 0, live: 0, granted: opts.granted !== false };
  const handle = {
    name: opts.name || 'test.smc',
    queryPermission: async () => (state.granted ? 'granted' : 'prompt'),
    requestPermission: async () => (state.granted ? 'granted' : 'denied'),
    createWritable: async () => {
      state.live++;
      state.concurrentPeak = Math.max(state.concurrentPeak, state.live);
      let swap = '';
      return {
        write: async (t) => {
          state.writeCalls++;
          if (opts.failWrite) { state.live--; throw new Error('disk full'); }
          // 模拟异步耗时，暴露并发
          await new Promise(r => setTimeout(r, 5));
          swap = t;
        },
        close: async () => { state.committed = swap; state.live--; },
        abort: async () => { state.live--; },
      };
    },
  };
  return { handle, state };
}

// ---- 阻塞-1：自动写回失败 → 持久告警 ----
test('阻塞-1 写失败触发持久 fileError 告警（不静默）', async () => {
  const app = makeStore();
  const { handle } = makeHandle({ failWrite: true, initial: 'OLD' });
  app.fileHandle = handle;
  await app.fileSaveToDisk(false); // 自动写回（无 showTip）
  assert.ok(app.fileError && app.fileError.length > 0, 'fileError 应被设置');
  assert.match(app.fileError, /未写入|失败/);
  assert.equal(app.fileState, 'dirty');
});

test('阻塞-1 写成功清除 fileError', async () => {
  const app = makeStore();
  app.fileError = '旧告警';
  const { handle, state } = makeHandle({ initial: 'OLD' });
  app.fileHandle = handle;
  await app.fileSaveToDisk(false);
  assert.equal(app.fileError, '');
  assert.equal(app.fileState, 'saved');
  assert.match(state.committed, /测试书/); // 内容确实写进去
});

// ---- 阻塞-1：权限写入途中被撤销 ----
test('阻塞-1 权限被撤销 → 标记需重连 + 持久告警', async () => {
  const app = makeStore();
  const { handle } = makeHandle({ granted: false });
  app.fileHandle = handle;
  await app.fileSaveToDisk(false);
  assert.equal(app.fileNeedsReconnect, true);
  assert.equal(app.fileState, 'dirty');
  assert.ok(app.fileError && app.fileError.length > 0);
});

// ---- 建议-2：并发写串行锁 ----
test('建议-2 并发写被串行化（createWritable 峰值并发=1）', async () => {
  const app = makeStore();
  const { handle, state } = makeHandle();
  app.fileHandle = handle;
  // 同时发起 3 次写
  const p1 = app.fileSaveToDisk(false);
  const p2 = app.fileSaveToDisk(false);
  const p3 = app.fileSaveToDisk(false);
  await Promise.all([p1, p2, p3]);
  assert.equal(state.concurrentPeak, 1, '同一时刻只能有一个 writable');
  // 合并语义：不必写满 3 次，但至少写了 1 次且最终态 saved
  assert.ok(state.writeCalls >= 1);
  assert.equal(app.fileState, 'saved');
});

test('建议-2 串行锁：排队期的重复请求合并为写完再补一次', async () => {
  const app = makeStore();
  const { handle, state } = makeHandle();
  app.fileHandle = handle;
  const first = app.fileSaveToDisk(false); // 占用链
  // 链在途时连发 5 次 → 应合并为「写完再补 1 次」，而非各自并发
  for (let i = 0; i < 5; i++) app.fileSaveToDisk(false);
  await first;
  // 等 pending 补写完
  await new Promise(r => setTimeout(r, 30));
  assert.equal(state.concurrentPeak, 1);
  assert.ok(state.writeCalls <= 2, '合并后写入次数应远小于 6，实际=' + state.writeCalls);
});

// ---- 建议-1：切档强制解绑 fileHandle ----
test('建议-1 switchProject 解绑旧档 fileHandle', async () => {
  const app = makeStore();
  const { handle } = makeHandle();
  app.fileHandle = handle;
  app.fileName = 'A.smc';
  app.fileState = 'saved';
  // 桩掉切档依赖
  app.projects = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }];
  app.autoDropEmptyCurrent = function () {};
  app.loadProjectData = function () {};
  app.select = function () {};
  app._restoreFileHandle = async function () { this._restored = true; };
  app.switchProject('p2');
  assert.equal(app.fileHandle, null, '切档后旧 handle 必须解绑');
  assert.equal(app.fileState, 'unlinked');
  assert.equal(app.fileNeedsReconnect, false);
  assert.equal(app._restored, true, '应尝试恢复目标档自己的句柄');
});

test('建议-1 resumeProject 同样解绑旧档 fileHandle', async () => {
  const app = makeStore();
  const { handle } = makeHandle();
  app.fileHandle = handle;
  app.fileState = 'saved';
  app.projects = [{ id: 'p2', name: 'B', lastAction: null }];
  app.currentProjectId = 'p1';
  app.autoDropEmptyCurrent = function () {};
  app.loadProjectData = function () {};
  app.select = function () {};
  app._restoreFileHandle = async function () {};
  app.resumeProject('p2');
  assert.equal(app.fileHandle, null);
  assert.equal(app.fileState, 'unlinked');
});

test('建议-1 切档前 flush：dirty 态会尝试把旧档写回旧 handle', async () => {
  const app = makeStore();
  const { handle, state } = makeHandle();
  app.fileHandle = handle;
  app.fileName = 'A.smc';
  app.fileState = 'dirty';
  app.projects = [{ id: 'p1' }, { id: 'p2' }];
  app.autoDropEmptyCurrent = function () {};
  app.loadProjectData = function () {};
  app.select = function () {};
  app._restoreFileHandle = async function () {};
  app.switchProject('p2');
  // flush 是 fire-and-forget，等它落地
  await new Promise(r => setTimeout(r, 30));
  assert.match(state.committed, /测试书/, '切档前应把旧档内容写回旧文件');
});
