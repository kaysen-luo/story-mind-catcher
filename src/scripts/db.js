// MVS-013 · v1.0 · T2 · Dexie / IndexedDB 数据层
// ------------------------------------------------------------------
// 设计原则（安全 > 优雅，见 T2 spec）:
//   1. 对外暴露 async API，语义与现有 LocalStorage 层对齐。
//   2. 不删 LocalStorage 原始数据 —— 迁移只打标记（`mvs-013-idb-migrated`）。
//   3. IDB 不可用（隐私模式 / 老浏览器 / 打开失败）→ isAvailable() 返回 false，
//      调用方回落 LocalStorage 路径，功能不中断。
//   4. 迁移幂等：跑多次结果一致，检测标记 + 不覆盖 IDB 里的新记录（策略：
//      「后写者不覆盖已存在的 archive」+ 「最终打完标记再返回」）。
//   5. 迁移失败：整体放弃、返回 { ok:false }，调用方继续用 LS。
//
// 采用「双写」策略（详见 delivery.md）：
//   - 读：主 session Alpine 是同步的，读走 LocalStorage（快、稳）。
//   - 写：saveProjectData / delete / rename 同步写 LS，异步写 IDB 一份。
//   - IDB 是持久化 backup + 未来 v1.1 导入/导出的数据源。
//
// Schema:
//   archives(id, updatedAt, name)  单条记录 = 单个项目档
//     字段: { id, name, createdAt, updatedAt, meta, payload }
//       - meta: 项目索引卡片信息（oneLineStory / worldTag / charsSummary / lastAction）
//       - payload: 完整项目 JSON（对应 LS 里 `mvs-013-project-<id>` 的整个对象）
//   kv(key)                        存全局键值（current / sort / …）
//
// 显式 version(1)，将来升级：`db.version(2).stores(...).upgrade(...)`。
// ------------------------------------------------------------------

import Dexie from 'dexie';
import { STORAGE } from './constants.js';

export const DB_NAME = 'mvs-013';
export const DB_VERSION = 1;
export const MIGRATED_KEY = 'mvs-013-idb-migrated';
export const MIGRATED_VALUE = 'v1'; // 版本化：将来 schema 升级可用不同标记重跑

let _db = null;
let _available = null; // null=未检测, true/false=已知

/**
 * 拿到 Dexie 实例（惰性）。任何 async 使用都应先 await ensureDb()。
 * 首次调用会尝试 open；open 失败 → _available=false，返回 null。
 */
export async function ensureDb() {
  if (_available === false) return null;
  if (_db) return _db;
  try {
    if (typeof indexedDB === 'undefined') {
      _available = false;
      console.warn('[mvs-013 db] IndexedDB 全局不存在，降级 LocalStorage');
      return null;
    }
    const db = new Dexie(DB_NAME);
    db.version(DB_VERSION).stores({
      // 主键 id；索引 updatedAt / name，方便未来排序/搜索
      archives: 'id, updatedAt, name',
      // kv 表：key 主键
      kv: 'key',
    });
    await db.open();
    _db = db;
    _available = true;
    return db;
  } catch (e) {
    _available = false;
    console.warn('[mvs-013 db] IndexedDB open 失败，降级 LocalStorage:', e && e.message);
    return null;
  }
}

export function isAvailableSync() {
  return _available === true;
}

/** 关闭并重置（测试用）。 */
export function _resetForTest() {
  if (_db) {
    try { _db.close(); } catch(e) {}
  }
  _db = null;
  _available = null;
}

// ============ archives API ============

export async function listArchives() {
  const db = await ensureDb();
  if (!db) return [];
  return db.archives.orderBy('updatedAt').reverse().toArray();
}

export async function loadArchive(id) {
  const db = await ensureDb();
  if (!db) return null;
  return (await db.archives.get(id)) || null;
}

/**
 * upsert：新增或覆盖。archive 至少包含 { id, name, payload }。
 * 用于运行时双写（写 LS 同时镜像到 IDB）。
 */
export async function saveArchive(archive) {
  const db = await ensureDb();
  if (!db) return false;
  if (!archive || !archive.id) throw new Error('saveArchive: archive.id required');
  const now = Date.now();
  const rec = {
    id: archive.id,
    name: archive.name || '',
    createdAt: archive.createdAt || now,
    updatedAt: archive.updatedAt || now,
    meta: archive.meta || {},
    payload: archive.payload || null,
  };
  await db.archives.put(rec);
  return true;
}

export async function deleteArchive(id) {
  const db = await ensureDb();
  if (!db) return false;
  await db.archives.delete(id);
  return true;
}

export async function renameArchive(id, name) {
  const db = await ensureDb();
  if (!db) return false;
  const rec = await db.archives.get(id);
  if (!rec) return false;
  rec.name = name;
  rec.updatedAt = Date.now();
  await db.archives.put(rec);
  return true;
}

// ============ kv API（current / sort 等全局键） ============

export async function kvGet(key) {
  const db = await ensureDb();
  if (!db) return null;
  const r = await db.kv.get(key);
  return r ? r.value : null;
}

export async function kvSet(key, value) {
  const db = await ensureDb();
  if (!db) return false;
  await db.kv.put({ key, value });
  return true;
}

// ============ 迁移 ============

/**
 * 检查 LS 是否已迁移过。
 * 幂等哨兵：ls 里 `mvs-013-idb-migrated=v1` 就算迁完。
 */
export function isMigrated(ls) {
  ls = ls || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!ls) return false;
  try { return ls.getItem(MIGRATED_KEY) === MIGRATED_VALUE; } catch(e) { return false; }
}

/**
 * 从 LocalStorage 迁移到 IndexedDB。
 *
 * 契约（T2 spec 5 条铁律）：
 *   1. 幂等：已标记 → 直接返回 { ok:true, skipped:true }。
 *   2. 不删源：全程只 getItem，绝不 removeItem / clear。
 *   3. 失败可退：任何一步 throw → 捕获、返回 { ok:false, error }、不写标记。
 *      调用方看到 ok:false 自动降级 LS。
 *   4. 迁移标记：全部写成功后才 setItem(MIGRATED_KEY, MIGRATED_VALUE)。
 *   5. 空数据兼容：LS 完全空 → 不 throw，仍打标记（下次不重跑），返回 ok:true。
 *
 * 迁移策略：不覆盖 IDB 里已存在的 archive（`if (!existing) put`），
 * 因为若用户已经在用 IDB 版本，那里的数据比 LS 新。
 *
 * @param {Storage} [ls] 注入 LocalStorage（测试用）；默认 window.localStorage
 * @returns {{ok:boolean, skipped?:boolean, migrated?:number, errors?:string[], error?:string}}
 */
export async function migrateFromLocalStorage(ls) {
  ls = ls || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!ls) return { ok: false, error: 'localStorage unavailable' };
  if (isMigrated(ls)) return { ok: true, skipped: true };

  const db = await ensureDb();
  if (!db) return { ok: false, error: 'IndexedDB unavailable' };

  const errors = [];
  let migratedCount = 0;

  try {
    // 1. 迁移项目索引 → kv('projects')
    const projectsRaw = ls.getItem(STORAGE.PROJECTS);
    let projects = [];
    if (projectsRaw) {
      try {
        projects = JSON.parse(projectsRaw) || [];
        if (!Array.isArray(projects)) projects = [];
      } catch (e) {
        errors.push('parse projects: ' + e.message);
        projects = [];
      }
    }

    // 2. 迁移 current
    const currentId = ls.getItem(STORAGE.CURRENT);

    // 3. 迁移 sort
    const sortRaw = ls.getItem(STORAGE.SORT);
    let sort = null;
    if (sortRaw) {
      try { sort = JSON.parse(sortRaw); } catch(e) { errors.push('parse sort: ' + e.message); }
    }

    // 4. 逐档迁移。单档失败不阻断，累计 errors。
    for (const proj of projects) {
      if (!proj || !proj.id) continue;
      try {
        const payloadRaw = ls.getItem(STORAGE.PROJECT_PREFIX + proj.id);
        let payload = null;
        if (payloadRaw) {
          try { payload = JSON.parse(payloadRaw); }
          catch (e) { errors.push('parse payload ' + proj.id + ': ' + e.message); continue; }
        }
        // 幂等：IDB 已有同 id → 不覆盖（尊重 IDB 里可能更新的数据）
        const existing = await db.archives.get(proj.id);
        if (existing) continue;
        await db.archives.put({
          id: proj.id,
          name: proj.name || '',
          createdAt: proj.createdAt || Date.now(),
          updatedAt: proj.updatedAt || Date.now(),
          meta: {
            oneLineStory: proj.oneLineStory || '',
            worldTag: proj.worldTag || '',
            charsSummary: proj.charsSummary || '',
            lastAction: proj.lastAction || null,
          },
          payload, // 完整 payload（含 data / current / _uid / asks）
        });
        migratedCount++;
      } catch (e) {
        errors.push('migrate ' + proj.id + ': ' + e.message);
      }
    }

    // 5. kv 全局值
    await db.kv.put({ key: 'projects_index', value: projects });
    if (currentId) await db.kv.put({ key: 'current', value: currentId });
    if (sort) await db.kv.put({ key: 'sort', value: sort });

    // 6. 全部成功才打标记（有 errors 也算「主流程走完」，errors 只记录了部分档解析失败）
    // 决策：即使有单档错误也打标记，避免下次重复扫全部档；用户如需可手动清除标记重跑。
    ls.setItem(MIGRATED_KEY, MIGRATED_VALUE);

    return { ok: true, migrated: migratedCount, errors };
  } catch (e) {
    // 主流程异常（如 IDB 写入被拒） → 不写标记、返回失败，让调用方降级 LS。
    console.error('[mvs-013 db] migration failed:', e);
    return { ok: false, error: (e && e.message) || String(e), errors };
  }
}

// 便捷：在 app 启动时调用。永不 throw。
export async function tryBootstrap() {
  try {
    const db = await ensureDb();
    if (!db) return { ok: false, reason: 'idb-unavailable' };
    const res = await migrateFromLocalStorage();
    return res;
  } catch (e) {
    console.warn('[mvs-013 db] bootstrap failed:', e);
    return { ok: false, reason: 'exception', error: e && e.message };
  }
}
