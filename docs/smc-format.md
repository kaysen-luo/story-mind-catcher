# `.smc` 文件格式说明（Story Mind Catcher）

> MVS-013 · v1.1 · 本地文件存储
> 署名：马启航Marvis

## 1. 是什么

`.smc`（**S**tory **M**ind **C**atcher）是 Story Mind Catcher 小说架构编辑器的**本地文件格式**。它本质是一个 **UTF-8 编码的 JSON 文本文件**，只是换了 `.smc` 后缀，让它成为用户硬盘上「看得见、拷得走、可备份」的真实文件。

- 运行时状态仍存在浏览器 LocalStorage / IndexedDB（不变）。
- `.smc` 是**用户可见的持久载体**，通过 Chrome/Edge 桌面版的 File System Access API 打开 / 保存。
- 不支持该 API 的浏览器（Safari / Firefox / iOS）会隐藏文件相关 UI，完全走原有 LocalStorage 行为。

## 2. 顶层结构

```json
{
  "formatVersion": "1.0",
  "app": "story-mind-catcher",
  "exportedAt": "2026-07-30T07:20:00.000Z",
  "data": { ...单档完整数据结构... }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `formatVersion` | string | ✅ | 格式版本号。当前 `"1.0"`。加载时校验是否在支持白名单内。 |
| `app` | string | ✅ | 固定 `"story-mind-catcher"`。加载时校验，非本应用文件给友好错误。 |
| `exportedAt` | string | ✅ | 导出时刻，ISO 8601 字符串（`new Date().toISOString()`）。 |
| `data` | object | ✅ | 单档完整数据，对应 app.js 里的 `this.data`。 |

## 3. `data` 内部结构

`data` 是编辑器单档的完整快照（与 LocalStorage `mvs-013-project-<id>` 里的 `data` 字段一致），主要板块：

| 键 | 说明 |
|---|---|
| `project` | 立项：书名、一句话故事、题材、基调、读者画像、篇幅、碎片池 |
| `world` | 世界观：时代、地点、世界规则、氛围、与现实差异、碎片池 |
| `characters` | 角色数组（每个含 name/age/gender/identity/occupation/situation/bio/欲望/恐惧/arc…） |
| `charactersPool` | 角色板块共享碎片池 |
| `conflict` | 冲突：外部主线、内在冲突、次要冲突、高潮场景、碎片池 |
| `chapters` | 章节数组（每章含 number/title/summary/fragments） |
| `fragments` | 全局碎片池 |
| `message` | 表达：核心表达、为何此刻、碎片池 |
| `antilist` | 反面清单：规避套路、规避主角光环、规避结局、碎片池 |

> `data` 的具体 schema 以 `src/scripts/app.js` 的 `defaultData()` 为准，会随版本演进。加载时用 `Object.assign(defaultData(), data)` 兜底缺失字段，向后兼容老档。

## 4. 加载校验规则（向后兼容）

加载 `.smc` 时按顺序校验，任一失败给友好中文错误提示，**不崩溃**：

1. **JSON 可解析** — 否则「文件不是有效的 JSON」。
2. **是对象**（非数组 / null）— 否则「文件内容格式不对」。
3. **`app === "story-mind-catcher"`** — 否则「这不是 Story Mind Catcher 的文件」。
4. **`formatVersion` 在支持白名单** — 当前白名单 `["1.0"]`；否则「不支持的文件版本，请升级应用」。
5. **`data` 是对象** — 否则「文件里没有有效的档案数据」。

## 5. 版本演进约定

- **新增字段**：直接加到 `data` 里，老应用用 `Object.assign(defaultData(), data)` 忽略未知字段，前向兼容。
- **破坏性结构变更**：升 `formatVersion`（如 `"2.0"`），并在 `SMC_SUPPORTED_VERSIONS` 白名单里保留旧版本 + 写迁移逻辑，避免老档打不开。
- **`app` 字段永不改**：它是「是不是本应用文件」的唯一判据。

## 6. 写入原子性（v1.1 修复段 · 2026-07-30）

写回 `.smc` 依赖 File System Access API 的 `createWritable()` **swap（临时）文件**机制：

- `createWritable()` 写的是浏览器内部 swap 文件，**只有 `close()` 成功时才原子替换到真实文件**。
- 任何中途失败（`write`/`close` 抛错、磁盘满、权限被撤销、标签页关闭）都会走 `abort()` 丢弃 swap，**原文件保持不变（不会被截断为空）**。
- 为什么不用 `<name>.smc.tmp` + rename：picker 只给到 `FileSystemFileHandle`（无目录句柄），FSA 的 `move()`/rename 仅桌面 Chrome 支持且需同目录语义，无法跨浏览器可靠实现；swap 机制本身已提供原子替换，无需自建临时文件。因此 **`.smc` 无 `.tmp` 后缀约定**。
- 写入传 `mode:'exclusive'`（不支持则退化到默认）+ app 层串行写入锁，双重避免同一文件并发写入报 `NoModificationAllowedError`。
- 自动写回失败**不静默**：弹持久型错误告警条（需手动关闭），且 LocalStorage 主存始终保住数据（降级保底）。

---

*Story Mind Catcher · 马启航Marvis*
