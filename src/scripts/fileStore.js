// MVS-013 · v1.1 · 本地文件存储桥（File System Access API + .smc）
// ------------------------------------------------------------------
// 设计原则（增量能力，安全 > 优雅）：
//   1. 与 LocalStorage 主存并存——LS 仍是运行时状态，.smc 是用户可见的持久载体。
//      本模块只负责「序列化整档 ↔ 硬盘 .smc 文件」，不碰 LS 读写主逻辑。
//   2. 能力降级：不支持 File System Access API 的浏览器（Safari/Firefox/iOS），
//      isSupported() 返回 false，调用方隐藏所有文件 UI，现有 LS 行为完全不变。
//   3. 纯逻辑（序列化 / 校验 / 文件名）与副作用（picker/读写）分离，便于单测。
//      picker/FS API 通过参数注入（默认取 window.*），测试可 mock。
//   4. fileHandle 由调用方存进 IndexedDB（Dexie 可直接存 FileSystemFileHandle）；
//      本模块只提供 query/request 权限的封装，且 requestPermission 必须由用户手势触发。
//
// .smc 格式（详见 docs/smc-format.md）：
//   {
//     "formatVersion": "1.0",
//     "app": "story-mind-catcher",
//     "exportedAt": "<ISO string>",
//     "data": { ...单档完整数据结构（对应 app.js 的 this.data）... }
//   }
// ------------------------------------------------------------------

export const SMC_APP = 'story-mind-catcher';
export const SMC_FORMAT_VERSION = '1.0';
// 已知可加载的 formatVersion 白名单（向后兼容用）。
export const SMC_SUPPORTED_VERSIONS = ['1.0'];
export const SMC_EXT = '.smc';

// showSaveFilePicker / showOpenFilePicker 的文件类型描述
export const SMC_PICKER_TYPES = [
  {
    description: '小说架构文件',
    accept: { 'application/json': [SMC_EXT] },
  },
];

/**
 * 能力检测：是否支持 File System Access API。
 * @param {object} [win] 注入 window（测试用），默认全局 window。
 * @returns {boolean}
 */
export function isSupported(win) {
  const w = win || (typeof window !== 'undefined' ? window : undefined);
  if (!w) return false;
  return typeof w.showOpenFilePicker === 'function'
    && typeof w.showSaveFilePicker === 'function';
}

/**
 * 把整档 data 序列化成 .smc 文件内容（JSON 字符串）。
 * @param {object} data 单档完整数据（app.js 的 this.data，建议已 strip 空白碎片）。
 * @param {object} [opts] { exportedAt } 可注入固定时间（测试用）。
 * @returns {string} 带缩进的 JSON 字符串。
 */
export function serializeSmc(data, opts = {}) {
  const doc = {
    formatVersion: SMC_FORMAT_VERSION,
    app: SMC_APP,
    exportedAt: opts.exportedAt || new Date().toISOString(),
    data: data == null ? {} : data,
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * 解析并校验 .smc 文件文本。
 * 校验顺序：JSON 可解析 → 是对象 → app 字段匹配 → formatVersion 在白名单 → data 存在。
 * @param {string} text 文件文本内容。
 * @returns {{ok:true, data:object, formatVersion:string, exportedAt:?string}
 *          | {ok:false, error:string, code:string}}
 */
export function parseSmc(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 'invalid-json', error: '文件不是有效的 JSON，可能已损坏或不是 .smc 文件。' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, code: 'not-object', error: '文件内容格式不对，不是有效的 .smc 文件。' };
  }
  if (doc.app !== SMC_APP) {
    return {
      ok: false,
      code: 'wrong-app',
      error: `这不是 Story Mind Catcher 的文件（app=${doc.app == null ? '缺失' : doc.app}）。`,
    };
  }
  if (!SMC_SUPPORTED_VERSIONS.includes(doc.formatVersion)) {
    return {
      ok: false,
      code: 'unsupported-version',
      error: `不支持的文件版本 formatVersion=${doc.formatVersion == null ? '缺失' : doc.formatVersion}，请升级应用后重试。`,
    };
  }
  if (doc.data == null || typeof doc.data !== 'object' || Array.isArray(doc.data)) {
    return { ok: false, code: 'no-data', error: '文件里没有有效的档案数据。' };
  }
  return {
    ok: true,
    data: doc.data,
    formatVersion: doc.formatVersion,
    exportedAt: typeof doc.exportedAt === 'string' ? doc.exportedAt : null,
  };
}

/**
 * 由书名生成默认文件名（带 .smc 后缀）。
 * 去掉文件系统非法字符，空标题回退「无题项目」。
 * @param {string} title 书名（data.project.title）。
 * @returns {string} 形如「三体设定.smc」。
 */
export function suggestFileName(title) {
  let base = (title == null ? '' : String(title)).trim();
  if (!base) base = '无题项目';
  // 去掉常见文件系统非法字符（Windows/macOS 保守集）
  base = base.replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '').trim();
  if (!base) base = '无题项目';
  // 控制长度，避免过长文件名
  if (base.length > 80) base = base.slice(0, 80);
  return base + SMC_EXT;
}

/**
 * 弹「打开文件」对话框，返回 fileHandle（不读内容）。
 * @param {object} [win] 注入 window（测试用）。
 * @returns {Promise<FileSystemFileHandle|null>} 用户取消返回 null。
 */
export async function pickOpenFile(win) {
  const w = win || (typeof window !== 'undefined' ? window : undefined);
  if (!w || typeof w.showOpenFilePicker !== 'function') {
    throw new Error('当前浏览器不支持打开本地文件');
  }
  try {
    const [handle] = await w.showOpenFilePicker({
      types: SMC_PICKER_TYPES,
      multiple: false,
      excludeAcceptAllOption: false,
    });
    return handle || null;
  } catch (e) {
    if (e && e.name === 'AbortError') return null; // 用户取消
    throw e;
  }
}

/**
 * 弹「另存为」对话框，返回 fileHandle（不写内容）。
 * @param {string} suggestedName 默认文件名（含 .smc）。
 * @param {object} [win] 注入 window（测试用）。
 * @returns {Promise<FileSystemFileHandle|null>} 用户取消返回 null。
 */
export async function pickSaveFile(suggestedName, win) {
  const w = win || (typeof window !== 'undefined' ? window : undefined);
  if (!w || typeof w.showSaveFilePicker !== 'function') {
    throw new Error('当前浏览器不支持保存本地文件');
  }
  try {
    const handle = await w.showSaveFilePicker({
      suggestedName: suggestedName || ('无题项目' + SMC_EXT),
      types: SMC_PICKER_TYPES,
      excludeAcceptAllOption: false,
    });
    return handle || null;
  } catch (e) {
    if (e && e.name === 'AbortError') return null;
    throw e;
  }
}

/**
 * 从 fileHandle 读取文本。
 * @param {FileSystemFileHandle} handle
 * @returns {Promise<string>}
 */
export async function readHandleText(handle) {
  if (!handle || typeof handle.getFile !== 'function') {
    throw new Error('无效的文件句柄');
  }
  const file = await handle.getFile();
  return file.text();
}

/**
 * 把文本原子地写回 fileHandle（阻塞-1 修复）。
 *
 * 原子性依据（已查证 MDN，2026-07-30）：
 *   File System Access API 的 createWritable() 写的是浏览器内部的
 *   **swap（临时）文件**，只有在 close() 成功时才把 swap 原子替换到真实文件。
 *   若中途 write() / close() 抛错、或标签页在 close 前关闭，swap 被丢弃、
 *   **原文件保持不变**（不会被截断为空）。因此关键动作是：任何失败都必须
 *   走 abort() 丢弃 swap，绝不 close() 半截内容。
 *
 * 为什么不用「.tmp 文件 + rename」方案：
 *   picker 只给到 FileSystemFileHandle（无目录句柄），FSA 的 move()/rename
 *   仅桌面 Chrome 支持且需同目录语义，无法跨浏览器可靠实现；而 swap 机制
 *   本身已提供原子替换，无需自建临时文件。
 * 为什么不用 keepExistingData:true + truncate：
 *   keepExistingData 只是把旧内容先拷进 swap（多一次拷贝），并不改变
 *   「close 才提交」这一原子语义；真正的保护是 abort-on-error，故不需要它。
 *
 * mode:'exclusive'（若浏览器支持）保证同一 handle 同时只允许一个 writer，
 *   配合上层写入锁，双重规避 NoModificationAllowedError（建议-2）。
 *
 * @param {FileSystemFileHandle} handle
 * @param {string} text
 * @returns {Promise<void>}
 * @throws 写入失败时向上抛错（原文件已由 abort 保护，未损坏）。
 */
export async function writeHandleText(handle, text) {
  if (!handle || typeof handle.createWritable !== 'function') {
    throw new Error('无效的文件句柄');
  }
  let writable;
  try {
    // 优先请求独占锁；老实现/mock 不认 options 也无妨（会忽略）。
    writable = await handle.createWritable({ mode: 'exclusive' });
  } catch (e) {
    // 某些实现对 exclusive 抛错时退化到默认（siloed）。
    writable = await handle.createWritable();
  }
  try {
    await writable.write(text);
    // close() 成功 = swap 原子提交到真实文件。
    await writable.close();
  } catch (e) {
    // 关键：中途失败必须 abort 丢弃 swap，保证原文件不被截断/写坏。
    try {
      if (typeof writable.abort === 'function') await writable.abort();
      else if (typeof writable.close === 'function') {
        // 无 abort 的退化实现：仍尝试 close 释放句柄（数据完整性由 swap 语义兜底）。
        await writable.close().catch(() => {});
      }
    } catch (_) { /* abort 本身失败也不掩盖原始错误 */ }
    throw e;
  }
}

/**
 * 查询 fileHandle 的读写权限状态。
 * @param {FileSystemFileHandle} handle
 * @param {boolean} [write=true] 是否查询写权限。
 * @returns {Promise<'granted'|'denied'|'prompt'>}
 */
export async function queryHandlePermission(handle, write = true) {
  if (!handle || typeof handle.queryPermission !== 'function') return 'denied';
  try {
    return await handle.queryPermission({ mode: write ? 'readwrite' : 'read' });
  } catch (e) {
    return 'denied';
  }
}

/**
 * 请求 fileHandle 权限。**必须由用户手势触发**（点击等），不能在 init 里自动调。
 * @param {FileSystemFileHandle} handle
 * @param {boolean} [write=true]
 * @returns {Promise<'granted'|'denied'|'prompt'>}
 */
export async function requestHandlePermission(handle, write = true) {
  if (!handle || typeof handle.requestPermission !== 'function') return 'denied';
  try {
    return await handle.requestPermission({ mode: write ? 'readwrite' : 'read' });
  } catch (e) {
    return 'denied';
  }
}
