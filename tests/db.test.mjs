// MVS-013 · T2 · db.js unit tests
// 用法：npm 未加 test script，直接 `node --test tests/db.test.mjs`
// 依赖：fake-indexeddb（devDep），把全局 indexedDB 打桩为内存实现。
//
// 覆盖：
//   1. 迁移幂等（重复跑 = 一次跑）
//   2. 迁移逐字段完整（含 patch7/8 新字段 age/occupation/situation/bio/arcFrom/arcTo/arcType）
//   3. 空 LocalStorage 兼容
//   4. 迁移失败回退（IDB open 失败 → 不写标记）
//   5. IDB 不可用降级（indexedDB 全局缺失 → ensureDb 返回 null）
//   6. 不删源数据（migrate 结束后所有 LS 原始 key 保留）
//   7. saveArchive / deleteArchive / renameArchive 语义
//   8. 迁移不覆盖 IDB 里已有的新记录（保护 IDB 内新数据）

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// 把 fake-indexeddb 装到全局
import 'fake-indexeddb/auto';

// 用一个内存 Storage 桩替换 localStorage
class MemStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i]; }
}

// 载入被测模块
let dbmod, STORAGE;
before(async () => {
  dbmod = await import('../src/scripts/db.js');
  ({ STORAGE } = await import('../src/scripts/constants.js'));
});

function makeLsWithFixture() {
  const ls = new MemStorage();
  // 一个项目索引 + 一份完整 payload（含 patch7/8 全字段）
  const proj = {
    id: 'proj-a', name: '示例项目', createdAt: 100, updatedAt: 200,
    oneLineStory: '一句话故事', worldTag: '现代·上海',
    charsSummary: '张三·主角', lastAction: { section: '角色', at: 200 },
  };
  ls.setItem(STORAGE.PROJECTS, JSON.stringify([proj]));
  ls.setItem(STORAGE.CURRENT, 'proj-a');
  ls.setItem(STORAGE.SORT, JSON.stringify({ by: 'updatedAt', order: 'desc' }));
  const payload = {
    v: '1.0.0-alpha.1',
    data: {
      project: { title: '示例项目', oneLineStory: '一句话故事', theme: '', genres: ['科幻'], toneWarmth: 50, toneHumor: 30, readerProfile: '', lengthType: '', fragments: [{ id: 'f1', text: '灵感 A', createdAt: 150 }] },
      world: { era: '现代', place: '上海', worldRules: '', atmosphere: '', diffFromReality: '', fragments: [] },
      characters: [
        {
          id: 'c1', name: '张三', role: '主角',
          // patch7 fields
          age: '28', identity: '侦探', occupation: '私家侦探', situation: '欠债跑路', bio: '一个疲惫的中年男人',
          // patch8 fields
          arcFrom: '愤世嫉俗', arcTo: '重拾希望', arcType: '救赎',
          // legacy
          desire: '找到真相', fear: '再次失败', fragments: [],
        },
      ],
      charactersPool: [{ id: 'cf1', text: '角色池碎片', createdAt: 150 }],
      conflict: { externalMain: '', internalMain: '', subConflict: '', climaxScene: '', fragments: [] },
      chapters: [{ id: 'ch1', number: 1, title: '第一章 楔子', content: '正文', fragments: [] }],
      fragments: [],
      message: { coreMessage: '', whyNow: '', fragments: [] },
      antilist: { avoidTropes: '', avoidHeroBecoming: '', avoidEndings: '', fragments: [] },
    },
    current: { type: 'project' },
    _uid: 5,
    asks: [{ id: 'ask1', text: '想想反面清单' }],
  };
  ls.setItem(STORAGE.PROJECT_PREFIX + 'proj-a', JSON.stringify(payload));
  return { ls, proj, payload };
}

// 每个 test 之前重置 IDB 状态 + 换新 db 名以隔离
import Dexie from 'dexie';
beforeEach(async () => {
  // 先删除旧 DB（如果存在），再重置模块状态
  try { await Dexie.delete(dbmod.DB_NAME); } catch(e) {}
  dbmod._resetForTest();
});

test('01 空 LocalStorage：迁移不报错，打标记', async () => {
  const ls = new MemStorage();
  const r = await dbmod.migrateFromLocalStorage(ls);
  assert.equal(r.ok, true);
  assert.equal(r.migrated, 0);
  assert.equal(dbmod.isMigrated(ls), true);
});

test('02 迁移逐字段完整（含 patch7/8 新字段）', async () => {
  const { ls } = makeLsWithFixture();
  const r = await dbmod.migrateFromLocalStorage(ls);
  assert.equal(r.ok, true);
  assert.equal(r.migrated, 1);
  const arc = await dbmod.loadArchive('proj-a');
  assert.ok(arc, 'archive exists');
  assert.equal(arc.name, '示例项目');
  assert.equal(arc.createdAt, 100);
  assert.equal(arc.updatedAt, 200);
  assert.equal(arc.meta.oneLineStory, '一句话故事');
  assert.equal(arc.meta.worldTag, '现代·上海');
  assert.equal(arc.meta.charsSummary, '张三·主角');
  const c = arc.payload.data.characters[0];
  // patch7
  assert.equal(c.age, '28');
  assert.equal(c.identity, '侦探');
  assert.equal(c.occupation, '私家侦探');
  assert.equal(c.situation, '欠债跑路');
  assert.equal(c.bio, '一个疲惫的中年男人');
  // patch8
  assert.equal(c.arcFrom, '愤世嫉俗');
  assert.equal(c.arcTo, '重拾希望');
  assert.equal(c.arcType, '救赎');
  // legacy
  assert.equal(c.desire, '找到真相');
  // 章节 & fragments 完整
  assert.equal(arc.payload.data.chapters[0].title, '第一章 楔子');
  assert.equal(arc.payload.data.project.fragments[0].text, '灵感 A');
  assert.equal(arc.payload.data.charactersPool[0].text, '角色池碎片');
  // asks
  assert.equal(arc.payload.asks[0].id, 'ask1');
  // kv
  assert.equal(await dbmod.kvGet('current'), 'proj-a');
  assert.deepEqual(await dbmod.kvGet('sort'), { by: 'updatedAt', order: 'desc' });
});

test('03 迁移幂等（跑两次结果一致）', async () => {
  const { ls } = makeLsWithFixture();
  const r1 = await dbmod.migrateFromLocalStorage(ls);
  const r2 = await dbmod.migrateFromLocalStorage(ls);
  assert.equal(r1.ok, true);
  assert.equal(r1.migrated, 1);
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, true);
  const all = await dbmod.listArchives();
  assert.equal(all.length, 1, '仍只有一档，不重复导入');
});

test('04 不删源数据：迁移后 LS 原 key 全部保留', async () => {
  const { ls, payload } = makeLsWithFixture();
  const beforeKeys = Array.from(ls.map.keys());
  const beforePayload = ls.getItem(STORAGE.PROJECT_PREFIX + 'proj-a');
  await dbmod.migrateFromLocalStorage(ls);
  // 原 key 全部还在
  for (const k of beforeKeys) assert.ok(ls.getItem(k) !== null, `LS key preserved: ${k}`);
  // payload 内容一字未改
  assert.equal(ls.getItem(STORAGE.PROJECT_PREFIX + 'proj-a'), beforePayload);
  // 只新增了标记 key
  assert.equal(ls.getItem(dbmod.MIGRATED_KEY), dbmod.MIGRATED_VALUE);
});

test('05 迁移不覆盖 IDB 里已存在的新数据', async () => {
  const { ls } = makeLsWithFixture();
  // 预先在 IDB 里写一版「更新」的 proj-a
  await dbmod.saveArchive({
    id: 'proj-a', name: 'IDB 里的新版',
    createdAt: 100, updatedAt: 999,
    payload: { data: { note: '新版内容' } },
  });
  const r = await dbmod.migrateFromLocalStorage(ls);
  assert.equal(r.ok, true);
  const arc = await dbmod.loadArchive('proj-a');
  assert.equal(arc.name, 'IDB 里的新版', 'IDB 里的记录未被覆盖');
});

test('06 IDB 不可用降级：indexedDB 全局缺失', async () => {
  const savedIDB = globalThis.indexedDB;
  try {
    delete globalThis.indexedDB;
    dbmod._resetForTest();
    const db = await dbmod.ensureDb();
    assert.equal(db, null);
    const r = await dbmod.migrateFromLocalStorage(new MemStorage());
    assert.equal(r.ok, false);
    assert.match(r.error, /unavailable/i);
  } finally {
    globalThis.indexedDB = savedIDB;
    dbmod._resetForTest();
  }
});

test('07 saveArchive / renameArchive / deleteArchive', async () => {
  await dbmod.saveArchive({ id: 'x', name: '甲', createdAt: 1, updatedAt: 2, payload: { hello: 1 } });
  let arc = await dbmod.loadArchive('x');
  assert.equal(arc.name, '甲');
  await dbmod.renameArchive('x', '乙');
  arc = await dbmod.loadArchive('x');
  assert.equal(arc.name, '乙');
  await dbmod.deleteArchive('x');
  arc = await dbmod.loadArchive('x');
  assert.equal(arc, null);
});

test('08 saveArchive 无 id 抛错（防意外覆盖）', async () => {
  await assert.rejects(() => dbmod.saveArchive({ name: '缺 id' }), /id required/);
});

test('09 单档 payload 解析失败：其他档不受影响、主流程仍 ok', async () => {
  const ls = new MemStorage();
  ls.setItem(STORAGE.PROJECTS, JSON.stringify([
    { id: 'good', name: '好档', createdAt: 1, updatedAt: 2 },
    { id: 'bad', name: '坏档', createdAt: 1, updatedAt: 2 },
  ]));
  ls.setItem(STORAGE.PROJECT_PREFIX + 'good', JSON.stringify({ data: { ok: true } }));
  ls.setItem(STORAGE.PROJECT_PREFIX + 'bad', '{ 不是合法 JSON');
  const r = await dbmod.migrateFromLocalStorage(ls);
  assert.equal(r.ok, true);
  assert.equal(r.migrated, 1);
  assert.ok(r.errors.some(e => e.includes('bad')), 'errors 记录了 bad 档');
  const good = await dbmod.loadArchive('good');
  assert.ok(good);
  const bad = await dbmod.loadArchive('bad');
  assert.equal(bad, null);
});
