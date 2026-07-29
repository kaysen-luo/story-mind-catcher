// MVS-013 · v1.0 · 主 Alpine 组件
// 从 v0.3.1 `storyEditor()` 原样搬运，业务逻辑 0 改动。
// 变更：
//   - STORAGE key / GENRE_OPTIONS 从 constants.js import（值未变）
//   - askRules / fallbackAsks 从 askAI.js import（数据未变）
//   - 事件总线用 nav-bus.js 的 onNav 包装（等价于原 window.addEventListener）
// T1 阶段保持整体 return 以保证 this 绑定与业务零回归；
// BRIEF 第 4 段建议的 projects/chapters/brainDump/uiCollapse 分组拆分推到 T6。

import { STORAGE, GENRE_OPTIONS } from './constants.js';
import * as db from './db.js';
import { tryBootstrap, saveArchive as idbSaveArchive, deleteArchive as idbDeleteArchive, renameArchive as idbRenameArchive, kvSet as idbKvSet } from './db.js';

// T2 (2026-07-28): 写-through 到 IDB。全部 fire-and-forget，不 await，
// 不影响同步主路径；IDB 不可用时 db.js 内部会静默降级。
function _idbMirrorArchive(proj, payload) {
  if (!proj) return;
  try {
    idbSaveArchive({
      id: proj.id,
      name: proj.name,
      createdAt: proj.createdAt,
      updatedAt: proj.updatedAt || Date.now(),
      meta: {
        oneLineStory: proj.oneLineStory || '',
        worldTag: proj.worldTag || '',
        charsSummary: proj.charsSummary || '',
        lastAction: proj.lastAction || null,
      },
      payload: payload || null,
    }).catch(e => console.warn('[mvs-013] idb mirror save fail:', e && e.message));
  } catch (e) { /* swallow */ }
}
function _idbMirrorDelete(id) {
  try { idbDeleteArchive(id).catch(() => {}); } catch(e) {}
}
function _idbMirrorKv(key, value) {
  try { idbKvSet(key, value).catch(() => {}); } catch(e) {}
}
import { askRules, fallbackAsks } from './askAI.js';
import { onNav } from './nav-bus.js';

export function createApp() {
  return {
    STORAGE_PROJECTS: STORAGE.PROJECTS,
    STORAGE_CURRENT: STORAGE.CURRENT,
    STORAGE_SORT: STORAGE.SORT,
    STORAGE_PROJECT_PREFIX: STORAGE.PROJECT_PREFIX,
    STORAGE_LEFT_COLLAPSED: STORAGE.LEFT_COLLAPSED,
    STORAGE_RIGHT_COLLAPSED: STORAGE.RIGHT_COLLAPSED,
    STORAGE_SKIP_FRAG_DELETE_CONFIRM: STORAGE.SKIP_FRAG_DELETE_CONFIRM,
    leftCollapsed: false,
    rightCollapsed: false,
    // T1-patch5 (2026-07-28): 碎片删除二次确认 + 「不再提醒」全局开关
    skipFragDeleteConfirm: false,
    fragDeleteConfirm: { open:false, scope:null, idx:-1, extraKey:null, dontAsk:false },
    // T1-patch5 (2026-07-28): 角色 modal (新增/编辑共用) + 删除二次确认
    characterModal: { open:false, mode:'edit', id:null, snapshot:null, confirmDelete:false, isNew:false },

    _uid: 0,
    _saveTimer: null,
    _flashTimer: null,
    _toastTimer: null,
    savedRecently: false,
    toast: '',
    mobileTreeOpen: false,
    mobilePreviewOpen: false,
    dumpModal: false,
    dumpText: '',
    dumpTarget: 'fragments',
    fragDraft: { type: '画面', content: '' },
    current: { type: 'project' },
    asks: [], // {id, q, targetType, targetId, targetField, answering, answerText}
    _lastAskScan: {},
    // v0.3 multi-project state
    projects: [], // Array<{id, name, createdAt, updatedAt, oneLineStory, worldTag, charsSummary, lastAction, _menuOpen, _renaming, _renameDraft}>
    currentProjectId: null,
    projectSort: { by: 'updatedAt', order: 'desc' },
    deleteModal: { open: false, id: null, name: '' },

    genreOptions: GENRE_OPTIONS,

    data: {
      project: { title:'', oneLineStory:'', theme:'', genres:[], toneWarmth:50, toneHumor:30, readerProfile:'', lengthType:'', fragments:[] },
      world:   { era:'', place:'', worldRules:'', atmosphere:'', diffFromReality:'', fragments:[] },
      characters: [],
      // T1-patch5 (2026-07-28): 角色板块共享碎片池（不再一角色一池）
      charactersPool: [],
      conflict:  { externalMain:'', internalMain:'', subConflict:'', climaxScene:'', fragments:[] },
      chapters:  [],
      fragments: [],
      message:   { coreMessage:'', whyNow:'', fragments:[] },
      antilist:  { avoidTropes:'', avoidHeroBecoming:'', avoidEndings:'', fragments:[] },
    },

    askRules,
    fallbackAsks,

    // ===== lifecycle =====
    init() {
      this.loadCollapsedState();
      this.loadSkipFragDeleteConfirm();
      // T2 (2026-07-28): 启动时尝试迁移 LS → IDB（不 await，不影响同步 boot）。
      // 任何失败都不会影响主路径，因为主路径仍走 LocalStorage。
      try { tryBootstrap().then(res => { if (res && res.ok && !res.skipped) console.info('[mvs-013] IDB migration:', res); }); } catch (e) {}
      this.loadProjectsIndex();
      this.loadSort();
      const curId = localStorage.getItem(this.STORAGE_CURRENT);
      if (curId && this.projects.find(p => p.id === curId)) {
        this.currentProjectId = curId;
        this.loadProjectData(curId);
      } else if (this.projects.length > 0) {
        this.currentProjectId = this.projects[0].id;
        this.loadProjectData(this.currentProjectId);
      } else {
        const p = this.newProjectRecord();
        this.projects.push(p);
        this.currentProjectId = p.id;
        this.resetData();
      }
      if (this.data.chapters.length === 0) {
        this.data.chapters.push(this.newChapter(1));
      }
      this.initFragmentPools();
      this.saveProjectData();
      this.saveProjectsIndex();
      // v0.3 fix 3: no deep watcher on data. touchData() handles saves + ask refresh.
      // T1-patch5: 弃用 current.type==='character' 独立诖图——若盘古机已落盘在该视图则归位到 characters-root
      if (this.current && this.current.type === 'character') this.current = { type: 'characters-root' };
      this.$watch('current', () => this.rescanAsks());
      // v0.3 fix 1: event bus for reverse-nav (replaces Alpine _x_dataStack access)
      onNav((detail) => this.select(detail));
      this.rescanAsks();
    },
    uid() { this._uid++; return Date.now().toString(36) + '-' + this._uid; },
    touchData(sectionHint, detailHint) {
      this.recordLastAction(sectionHint, detailHint);
      this.saveDebounced();
      clearTimeout(this._askTimer);
      this._askTimer = setTimeout(() => this.rescanAsks(), 400);
    },

    // ===== persistence (v0.3 multi-project) =====
    saveDebounced() {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.saveProjectData(), 300);
    },
    loadCollapsedState() {
      try {
        this.leftCollapsed = localStorage.getItem(this.STORAGE_LEFT_COLLAPSED) === 'true';
        this.rightCollapsed = localStorage.getItem(this.STORAGE_RIGHT_COLLAPSED) === 'true';
        this.$nextTick(() => { document.body.classList.toggle('right-collapsed', this.rightCollapsed); document.body.classList.toggle('left-collapsed', this.leftCollapsed); });
      } catch(e) {}
    },
    toggleLeftCollapsed() {
      this.leftCollapsed = !this.leftCollapsed;
      document.body.classList.toggle('left-collapsed', this.leftCollapsed);
      try { localStorage.setItem(this.STORAGE_LEFT_COLLAPSED, String(this.leftCollapsed)); } catch(e) {}
    },
    toggleRightCollapsed() {
      this.rightCollapsed = !this.rightCollapsed;
      document.body.classList.toggle('right-collapsed', this.rightCollapsed);
      try { localStorage.setItem(this.STORAGE_RIGHT_COLLAPSED, String(this.rightCollapsed)); } catch(e) {}
    },
    // v0.3.1: compact chapter label for collapsed left rail
    // Rules: 序章→「序」, 引子→「引」, 尾声→「尾」; 中文数字章号→阿拉伯数字; 子节 X.Y
    chapterShortLabel(ch) {
      const title = (ch.title || '').trim();
      if (title.startsWith('序')) return '序';
      if (title.startsWith('引')) return '引';
      if (title.startsWith('尾')) return '尾';
      // Detect 第 X 章第 Y 幕 style subsection (kept simple; data model has no children yet)
      const m = title.match(/第\s*([一二三四五六七八九十\d]+)\s*章\s*(?:第\s*([一二三四五六七八九十\d]+)\s*(?:幕|节))?/);
      if (m) {
        const a = this._cnToNum(m[1]);
        const b = m[2] ? this._cnToNum(m[2]) : null;
        if (a) return b ? (a + '.' + b) : String(a);
      }
      return String(ch.number || '');
    },
    _cnToNum(s) {
      if (!s) return null;
      if (/^\d+$/.test(s)) return parseInt(s, 10);
      const map = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10};
      if (map[s]) return map[s];
      // simple 十X / X十 / X十Y
      if (/^十/.test(s)) { const t = map[s.slice(1)]||0; return 10 + t; }
      if (/十$/.test(s)) { const t = map[s.slice(0,-1)]||1; return t*10; }
      const mm = s.match(/^([一-九])十([一-九])$/);
      if (mm) return map[mm[1]]*10 + map[mm[2]];
      return null;
    },
    loadProjectsIndex() {
      try {
        const raw = localStorage.getItem(this.STORAGE_PROJECTS);
        if (!raw) { this.projects = []; return; }
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          this.projects = arr.map(p => Object.assign({
            _menuOpen: false, _renaming: false, _renameDraft: ''
          }, p));
        }
      } catch(e) { console.error('loadProjectsIndex fail', e); this.projects = []; }
    },
    saveProjectsIndex() {
      try {
        const clean = this.projects.map(p => ({
          id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
          oneLineStory: p.oneLineStory || '', worldTag: p.worldTag || '',
          charsSummary: p.charsSummary || '', lastAction: p.lastAction || null,
        }));
        localStorage.setItem(this.STORAGE_PROJECTS, JSON.stringify(clean));
        _idbMirrorKv('projects_index', clean);
      } catch(e) { console.error('saveProjectsIndex fail', e); }
    },
    loadSort() {
      try {
        const raw = localStorage.getItem(this.STORAGE_SORT);
        if (raw) this.projectSort = Object.assign(this.projectSort, JSON.parse(raw));
      } catch(e) {}
    },
    saveProjectSort() {
      try { localStorage.setItem(this.STORAGE_SORT, JSON.stringify(this.projectSort)); } catch(e){}
    },
    loadProjectData(id) {
      try {
        const raw = localStorage.getItem(this.STORAGE_PROJECT_PREFIX + id);
        if (!raw) {
          this.resetData(); this.asks = []; this._lastAskScan = {};
          this.current = { type: 'project' };
          if (this.data.chapters.length === 0) this.data.chapters.push(this.newChapter(1));
          this.initFragmentPools();
          return;
        }
        const p = JSON.parse(raw);
        this.data = p.data ? Object.assign(this.defaultData(), p.data) : this.defaultData();
        this.current = p.current || { type: 'project' };
        this._uid = typeof p._uid === 'number' ? p._uid : 0;
        this.asks = Array.isArray(p.asks) ? p.asks : [];
        this._lastAskScan = {};
        this.initFragmentPools();
      } catch(e) { console.error('loadProjectData fail', e); this.resetData(); this.initFragmentPools(); }
    },
    // T1-patch2 (2026-07-27) Bug 1: 是否是「无题项目 (stamp)」这种默认名，可被 title 单向覆盖。
    _isDefaultProjectName(name) {
      return typeof name === 'string' && /^无题项目\s*\(.+\)$/.test(name.trim());
    },
    saveProjectData() {
      if (!this.currentProjectId) return;
      try {
        // T1-patch4 (2026-07-28): 持久化前剔除空白碎片卡（占位不落盘），
        // 仅作用在副本上，界面上正在编辑的空白卡不动，避免响应式抖动。
        const cleanedData = this._stripBlankFragmentsForSave(this.data);
        const payload = { v:'1.0.0-alpha.1', data:cleanedData, current:this.current, _uid:this._uid, asks:this.asks };
        localStorage.setItem(this.STORAGE_PROJECT_PREFIX + this.currentProjectId, JSON.stringify(payload));
        const proj = this.projects.find(p => p.id === this.currentProjectId);
        if (proj) {
          proj.updatedAt = Date.now();
          // T1-patch2 Bug 1: title → name 单向同步，只在 name 仍为默认值时覆盖，保留手动 rename 权重。
          const title = (this.data.project.title || '').trim();
          if (title && this._isDefaultProjectName(proj.name)) {
            proj.name = title;
          }
          proj.oneLineStory = this.data.project.oneLineStory || this.data.project.theme || '';
          const era = this.data.world.era || '', place = this.data.world.place || '';
          proj.worldTag = [era, place].filter(Boolean).join('·');
          proj.charsSummary = this.buildCharsSummary();
          this.saveProjectsIndex();
          // T2: 写-through IDB
          _idbMirrorArchive(proj, payload);
        }
        this.savedRecently = true;
        clearTimeout(this._flashTimer);
        this._flashTimer = setTimeout(() => this.savedRecently = false, 1500);
      } catch(e) { console.error('save fail', e); }
    },
    defaultData() {
      return {
        project: { title:'', oneLineStory:'', theme:'', genres:[], toneWarmth:50, toneHumor:30, readerProfile:'', lengthType:'', fragments:[] },
        world:   { era:'', place:'', worldRules:'', atmosphere:'', diffFromReality:'', fragments:[] },
        characters: [],
        charactersPool: [],
        conflict:  { externalMain:'', internalMain:'', subConflict:'', climaxScene:'', fragments:[] },
        chapters:  [],
        fragments: [],
        message:   { coreMessage:'', whyNow:'', fragments:[] },
        antilist:  { avoidTropes:'', avoidHeroBecoming:'', avoidEndings:'', fragments:[] },
      };
    },
    // T1-patch5 (2026-07-28): 「不再提醒」开关持久化
    loadSkipFragDeleteConfirm() {
      try { this.skipFragDeleteConfirm = localStorage.getItem(this.STORAGE_SKIP_FRAG_DELETE_CONFIRM) === 'true'; } catch(e) {}
    },
    persistSkipFragDeleteConfirm() {
      try { localStorage.setItem(this.STORAGE_SKIP_FRAG_DELETE_CONFIRM, String(this.skipFragDeleteConfirm)); } catch(e) {}
    },
    // T1-patch2 (2026-07-27): lazy migrate 老档补齐每板块碎片池，不动老正文。
    // T1-patch4 (2026-07-28): 加载后为每个板块池补一张空白卡（保持「永远有地方写」）。
    initFragmentPools() {
      const d = this.data;
      if (!Array.isArray(d.project.fragments)) d.project.fragments = [];
      if (!Array.isArray(d.world.fragments)) d.world.fragments = [];
      if (!Array.isArray(d.conflict.fragments)) d.conflict.fragments = [];
      if (!Array.isArray(d.message.fragments)) d.message.fragments = [];
      if (!Array.isArray(d.antilist.fragments)) d.antilist.fragments = [];
      if (!Array.isArray(d.fragments)) d.fragments = [];
      if (!Array.isArray(d.charactersPool)) d.charactersPool = [];
      (d.characters || []).forEach(c => { if (!Array.isArray(c.fragments)) c.fragments = []; });
      (d.chapters || []).forEach(ch => { if (!Array.isArray(ch.fragments)) ch.fragments = []; });
      // T1-patch7 (2026-07-28): 补齐角色新字段（age/occupation/situation/bio），identity 原样保留。幂等：只在字段不存在时补空串，已存在的用户内容一律不覆盖。
      // T1-patch8 (2026-07-28): 追加 arcFrom / arcTo / arcType 三字段迁移，规则同上。
      (d.characters || []).forEach(c => {
        if (typeof c.age !== 'string') c.age = '';
        if (typeof c.gender !== 'string') c.gender = ''; // T1-patch9
        if (typeof c.identity !== 'string') c.identity = '';
        if (typeof c.occupation !== 'string') c.occupation = '';
        if (typeof c.situation !== 'string') c.situation = '';
        if (typeof c.bio !== 'string') c.bio = '';
        if (typeof c.arcFrom !== 'string') c.arcFrom = '';
        if (typeof c.arcTo !== 'string') c.arcTo = '';
        if (typeof c.arcType !== 'string') c.arcType = '';
      });
      // T1-patch5 (2026-07-28): 老档迁移——将各角色 fragments 里有内容的碎片合并进 charactersPool，清空角色 fragments。
      // 幂等：只搜非空碎片，并交集去重（以 id 为键）；迁移后角色 fragments 清空（保留字段、置为 []）。
      const seenIds = new Set(d.charactersPool.filter(f => f && f.id).map(f => f.id));
      (d.characters || []).forEach(c => {
        if (!Array.isArray(c.fragments)) return;
        c.fragments.forEach(f => {
          if (this._isBlankFragment(f)) return;
          if (f && f.id && seenIds.has(f.id)) return; // 幂等：同 id 不重入
          d.charactersPool.push(f);
          if (f && f.id) seenIds.add(f.id);
        });
        c.fragments = []; // 已迁移，清空
      });
      // 各板块池：空池补一张空白卡
      this._ensureBlankIfEmpty(d.project.fragments);
      this._ensureBlankIfEmpty(d.world.fragments);
      this._ensureBlankIfEmpty(d.conflict.fragments);
      this._ensureBlankIfEmpty(d.message.fragments);
      this._ensureBlankIfEmpty(d.antilist.fragments);
      this._ensureBlankIfEmpty(d.charactersPool);
      (d.chapters || []).forEach(ch => this._ensureBlankIfEmpty(ch.fragments));
    },
    // ===== T1-patch4 (2026-07-28) 碎片池交互 v2：池内直接可写 + ＋按钮 =====
    // 公共方法：poolOf / poolCount / poolHasBlank / addBlankFragment / _ensureBlankIfEmpty
    // deleteFragment 保留同名，内部改为「删空后自动补一张空白卡」。
    _isBlankFragment(f) {
      return !f || typeof f.text !== 'string' || f.text.trim() === '';
    },
    _ensureBlankIfEmpty(arr) {
      if (!Array.isArray(arr)) return;
      if (arr.length === 0) arr.push({ id: this.uid(), text: '', createdAt: Date.now() });
    },
    poolOf(scope, extraKey) {
      return this._resolveFragmentTarget(scope, extraKey) || [];
    },
    poolCount(scope, extraKey) {
      const arr = this._resolveFragmentTarget(scope, extraKey);
      if (!Array.isArray(arr)) return 0;
      let n = 0;
      for (const f of arr) if (!this._isBlankFragment(f)) n++;
      return n;
    },
    poolHasBlank(scope, extraKey) {
      const arr = this._resolveFragmentTarget(scope, extraKey);
      if (!Array.isArray(arr)) return false;
      for (const f of arr) if (this._isBlankFragment(f)) return true;
      return false;
    },
    // T1-patch10 (2026-07-29): 池内只剩最后一条时隐藏删除入口
    // 根因：deleteFragment 删空后会自动补一张空白卡，导致最后一条“点了没反应”。
    canDeleteFragment(scope, extraKey) {
      const arr = this._resolveFragmentTarget(scope, extraKey);
      return Array.isArray(arr) && arr.length > 1;
    },
    addBlankFragment(scope, extraKey) {
      const arr = this._resolveFragmentTarget(scope, extraKey);
      if (!Array.isArray(arr)) return;
      // 已有空白卡不重复加
      for (const f of arr) if (this._isBlankFragment(f)) return;
      arr.unshift({ id: this.uid(), text: '', createdAt: Date.now() });
      // 空白卡本身不落盘（saveProjectData 会过滤），此处不 touchData 避免噪声
    },
    // T1-patch5 (2026-07-28): 碎片删除二次确认入口（受「不再提醒」开关控制）
    // 7 个板块池 + 角色共享池均走这里；角色本体删除不受此开关影响（重资产，永远确认）。
    requestDeleteFragment(scope, idx, extraKey) {
      if (this.skipFragDeleteConfirm) {
        this.deleteFragment(scope, idx, extraKey);
        return;
      }
      this.fragDeleteConfirm = { open:true, scope, idx, extraKey: extraKey || null, dontAsk:false };
    },
    confirmFragDelete() {
      const c = this.fragDeleteConfirm;
      if (!c.open) return;
      if (c.dontAsk) {
        this.skipFragDeleteConfirm = true;
        this.persistSkipFragDeleteConfirm();
      }
      this.deleteFragment(c.scope, c.idx, c.extraKey);
      this.fragDeleteConfirm = { open:false, scope:null, idx:-1, extraKey:null, dontAsk:false };
    },
    cancelFragDelete() {
      this.fragDeleteConfirm = { open:false, scope:null, idx:-1, extraKey:null, dontAsk:false };
    },
    // 持久化副本：过滤所有板块池里的空白卡（保护全局池 data.fragments 的 {id,type,content} 结构不动）。
    _stripBlankFragmentsForSave(data) {
      const clean = JSON.parse(JSON.stringify(data));
      const isBlank = (f) => !f || typeof f.text !== 'string' || f.text.trim() === '';
      const filt = (arr) => Array.isArray(arr) ? arr.filter(f => !isBlank(f)) : arr;
      if (clean.project) clean.project.fragments = filt(clean.project.fragments);
      if (clean.world) clean.world.fragments = filt(clean.world.fragments);
      if (clean.conflict) clean.conflict.fragments = filt(clean.conflict.fragments);
      if (clean.message) clean.message.fragments = filt(clean.message.fragments);
      if (clean.antilist) clean.antilist.fragments = filt(clean.antilist.fragments);
      if (Array.isArray(clean.charactersPool)) clean.charactersPool = filt(clean.charactersPool);
      (clean.characters || []).forEach(c => c.fragments = filt(c.fragments));
      (clean.chapters || []).forEach(ch => ch.fragments = filt(ch.fragments));
      return clean;
    },
    resetData() { this.data = this.defaultData(); },
    isDataEmpty() {
      const d = this.data;
      const flat = [d.project.title, d.project.oneLineStory, d.project.theme, d.project.readerProfile, d.project.lengthType,
        d.world.era, d.world.place, d.world.worldRules, d.world.atmosphere, d.world.diffFromReality,
        d.conflict.externalMain, d.conflict.internalMain, d.conflict.subConflict, d.conflict.climaxScene,
        d.message.coreMessage, d.message.whyNow,
        d.antilist.avoidTropes, d.antilist.avoidHeroBecoming, d.antilist.avoidEndings];
      if (flat.some(s => (s||'').toString().trim() !== '')) return false;
      if ((d.project.genres||[]).length > 0) return false;
      if (d.characters.length > 0) return false;
      if (d.fragments.length > 0) return false;
      if (d.chapters.length > 1) return false;
      if (d.chapters.length === 1) {
        const c = d.chapters[0];
        if ((c.title||c.oneLine||c.pov||c.keyScenes||'').toString().trim() !== '') return false;
        if ((c.characters||[]).length > 0) return false;
      }
      return true;
    },
    buildCharsSummary() {
      const roleOrder = { '主角':0, '配角':1, '反派':2 };
      const named = this.data.characters.filter(c => (c.name||'').trim() !== '');
      const sorted = [...named].sort((a,b) => (roleOrder[a.role]??9) - (roleOrder[b.role]??9));
      if (sorted.length === 0) return '';
      const first3 = sorted.slice(0,3).map(c => c.name).join('、');
      const extra = sorted.length > 3 ? ` +${sorted.length-3}` : '';
      return first3 + extra;
    },
    recordLastAction(section, detail) {
      if (!this.currentProjectId) return;
      const trackable = ['立项','世界观','角色','冲突','章节'];
      if (!section) {
        const map = { project:'立项', world:'世界观', 'characters-root':'角色', character:'角色',
          conflict:'冲突', 'chapters-root':'章节', chapter:'章节' };
        section = map[this.current.type];
        if (!section) return;
        detail = detail || this.inferDetail();
      }
      if (!trackable.includes(section)) return;
      const proj = this.projects.find(p => p.id === this.currentProjectId);
      if (proj) proj.lastAction = { section, detail: detail || '编辑中', ts: Date.now() };
    },
    inferDetail() {
      const t = this.current.type;
      if (t === 'project') return (this.data.project.title || '一句话故事') + ' 编辑中';
      if (t === 'world') return '世界观编辑中';
      if (t === 'characters-root') return '角色列表';
      if (t === 'character') { const c = this.currentCharacter(); return (c?.name || '新角色') + ' 编辑中'; }
      if (t === 'conflict') return '冲突编辑中';
      if (t === 'chapters-root') return '章节列表';
      if (t === 'chapter') { const c = this.currentChapter(); return 'Ch'+String(c?.number||'').padStart(2,'0')+' '+(c?.title||'未命名') + ' 编辑中'; }
      return '编辑中';
    },
    resetAll() {
      if (!confirm('确定重置当前项目的全部数据？此操作不可撤销。')) return;
      if (!confirm('二次确认：当前项目的所有节点内容都会被清空。真的继续？')) return;
      if (this.currentProjectId) { localStorage.removeItem(this.STORAGE_PROJECT_PREFIX + this.currentProjectId); _idbMirrorDelete(this.currentProjectId); }
      location.reload();
    },

    // ===== v0.3 project management =====
    newProjectRecord() {
      const now = Date.now();
      const d = new Date(now);
      const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      return {
        id: this.uid(), name: `无题项目 (${stamp})`,
        createdAt: now, updatedAt: now,
        oneLineStory: '', worldTag: '', charsSummary: '', lastAction: null,
        _menuOpen: false, _renaming: false, _renameDraft: '',
      };
    },
    sortedProjects() {
      const by = this.projectSort.by, order = this.projectSort.order;
      const arr = [...this.projects];
      arr.sort((a,b) => {
        const va = a[by] || 0, vb = b[by] || 0;
        return order === 'asc' ? va - vb : vb - va;
      });
      return arr;
    },
    createProject() {
      this.autoDropEmptyCurrent();
      const p = this.newProjectRecord();
      this.projects.push(p);
      this.currentProjectId = p.id;
      localStorage.setItem(this.STORAGE_CURRENT, p.id);
      this.resetData();
      this.asks = []; this._lastAskScan = {};
      this.data.chapters.push(this.newChapter(1));
      this.saveProjectData();
      this.saveProjectsIndex();
      this.select({ type: 'project' });
      this.showToast('已新建项目');
    },
    autoDropEmptyCurrent() {
      if (!this.currentProjectId) return false;
      if (this.isDataEmpty()) {
        const idx = this.projects.findIndex(p => p.id === this.currentProjectId);
        if (idx >= 0) {
          localStorage.removeItem(this.STORAGE_PROJECT_PREFIX + this.currentProjectId);
          _idbMirrorDelete(this.currentProjectId);
          this.projects.splice(idx, 1);
          this.saveProjectsIndex();
        }
        this.currentProjectId = null;
        return true;
      }
      this.saveProjectData();
      return false;
    },
    switchProject(id, targetNode) {
      if (id === this.currentProjectId) return;
      this.autoDropEmptyCurrent();
      const proj = this.projects.find(p => p.id === id);
      if (!proj) return;
      this.currentProjectId = id;
      localStorage.setItem(this.STORAGE_CURRENT, id);
      this.loadProjectData(id);
      this.select(targetNode || { type: 'project' });
    },
    resumeProject(id) {
      const proj = this.projects.find(p => p.id === id);
      if (!proj) return;
      this.autoDropEmptyCurrent();
      this.currentProjectId = id;
      localStorage.setItem(this.STORAGE_CURRENT, id);
      this.loadProjectData(id);
      const la = proj.lastAction;
      let target = { type: 'project' };
      if (la) {
        const map = { '立项':'project', '世界观':'world', '角色':'characters-root',
          '冲突':'conflict', '章节':'chapters-root' };
        const t = map[la.section];
        if (t) target = { type: t };
      }
      this.select(target);
    },
    toggleCardMenu(proj) {
      const wasOpen = proj._menuOpen;
      this.projects.forEach(p => p._menuOpen = false);
      proj._menuOpen = !wasOpen;
    },
    startRename(proj) {
      proj._renameDraft = proj.name;
      proj._renaming = true;
      proj._menuOpen = false;
    },
    commitRename(proj) {
      if (!proj._renaming) return;
      const v = (proj._renameDraft || '').trim();
      if (v) proj.name = v;
      proj._renaming = false;
      proj.updatedAt = Date.now();
      this.saveProjectsIndex();
    },
    duplicateProject(id) {
      if (id === this.currentProjectId) this.saveProjectData();
      const src = this.projects.find(p => p.id === id);
      if (!src) return;
      const raw = localStorage.getItem(this.STORAGE_PROJECT_PREFIX + id);
      const newP = this.newProjectRecord();
      newP.name = src.name + ' 副本';
      newP.oneLineStory = src.oneLineStory;
      newP.worldTag = src.worldTag;
      newP.charsSummary = src.charsSummary;
      this.projects.push(newP);
      if (raw) { localStorage.setItem(this.STORAGE_PROJECT_PREFIX + newP.id, raw); try { _idbMirrorArchive(newP, JSON.parse(raw)); } catch(e) {} }
      this.saveProjectsIndex();
      src._menuOpen = false;
      this.showToast('已复制副本');
    },
    exportProject(id) {
      if (id === this.currentProjectId) { this.downloadMd(); }
      else {
        const raw = localStorage.getItem(this.STORAGE_PROJECT_PREFIX + id);
        if (!raw) { this.showToast('没有内容可导出'); return; }
        const savedData = JSON.parse(JSON.stringify(this.data));
        try {
          const p = JSON.parse(raw);
          this.data = Object.assign(this.defaultData(), p.data || {});
          this.downloadMd();
        } finally {
          this.data = savedData;
        }
      }
      const proj = this.projects.find(p => p.id === id);
      if (proj) proj._menuOpen = false;
    },
    askDeleteProject(proj) {
      proj._menuOpen = false;
      this.deleteModal = { open: true, id: proj.id, name: proj.name };
    },
    confirmDeleteProject() {
      const id = this.deleteModal.id;
      if (!id) { this.deleteModal.open = false; return; }
      localStorage.removeItem(this.STORAGE_PROJECT_PREFIX + id);
      _idbMirrorDelete(id);
      const idx = this.projects.findIndex(p => p.id === id);
      if (idx >= 0) this.projects.splice(idx, 1);
      const wasCurrent = id === this.currentProjectId;
      if (wasCurrent) {
        if (this.projects.length > 0) {
          this.currentProjectId = this.projects[0].id;
          localStorage.setItem(this.STORAGE_CURRENT, this.currentProjectId);
          this.loadProjectData(this.currentProjectId);
          this.select({ type: 'project' });
        } else {
          this.currentProjectId = null;
          localStorage.removeItem(this.STORAGE_CURRENT);
          this.resetData();
          this.asks = [];
          this.select({ type: 'projects' });
        }
      }
      this.saveProjectsIndex();
      this.deleteModal = { open: false, id: null, name: '' };
      this.showToast('已删除');
    },
    relTime(ts) {
      if (!ts) return '';
      const diff = Date.now() - ts;
      const min = 60*1000, hr = 60*min, day = 24*hr;
      if (diff < min) return '刚刚';
      if (diff < hr) return Math.floor(diff/min) + ' 分钟前';
      if (diff < day) return Math.floor(diff/hr) + ' 小时前';
      if (diff < 2*day) return '昨天';
      if (diff < 30*day) return Math.floor(diff/day) + ' 天前';
      const d = new Date(ts);
      return `${d.getMonth()+1} 月 ${d.getDate()} 日`;
    },

    // ===== navigation =====
    select(target) {
      // T1-patch5: 废弃 current.type==='character' 视图——若命中则钩到角色板块并开 modal
      if (target && target.type === 'character') {
        this.current = { type: 'characters-root' };
        this.mobileTreeOpen = false;
        this.$nextTick(() => this.openCharacterModal(target.id));
        return;
      }
      this.current = target;
      this.mobileTreeOpen = false;
      if (target && target.type && target.type !== 'projects') {
        this.recordLastAction();
        this.saveDebounced();
      }
    },
    breadcrumb() {
      const t = this.current.type;
      const map = {
        'project':'📖 立项', 'world':'🌍 世界观',
        'characters-root':'🎭 角色', 'conflict':'⚔️ 冲突',
        'chapters-root':'📚 章节', 'fragments':'🎬 碎片池',
        'message':'🎯 表达', 'antilist':'🚫 反面清单',
        'projects':'📚 已立项目',
      };
      if (t === 'projects') return `<span class="current">📚 已立项目</span>`;
      if (t === 'character') {
        const c = this.currentCharacter();
        return `<span>🎭 角色</span><span class="sep">›</span><span class="current">${this._esc(c?.name || '（未命名）')}</span>`;
      }
      if (t === 'chapter') {
        const ch = this.currentChapter();
        const num = ch ? 'Ch'+String(ch.number).padStart(2,'0') : '';
        return `<span>📚 章节</span><span class="sep">›</span><span class="current">${num} · ${this._esc(ch?.title || '（未命名）')}</span>`;
      }
      return `<span class="current">${map[t] || ''}</span>`;
    },
    formTitle() {
      const t = this.current.type;
      const titles = {
        'project':'📖 立项','world':'🌍 世界观','characters-root':'🎭 角色列表',
        'conflict':'⚔️ 冲突','chapters-root':'📚 章节列表','fragments':'🎬 碎片池',
        'message':'🎯 想表达什么','antilist':'🚫 反面清单',
        'projects':'📚 已立项目',
      };
      if (t === 'character') {
        const c = this.currentCharacter();
        return `${this.roleEmoji(c?.role)} ${this._esc(c?.name || '（未命名角色）')}`;
      }
      if (t === 'chapter') {
        const ch = this.currentChapter();
        return `📄 Ch${String(ch?.number||'').padStart(2,'0')} · ${this._esc(ch?.title || '（未命名章节）')}`;
      }
      return titles[t] || '';
    },
    _esc(s) { return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); },

    // ===== characters =====
    newCharacter() {
      // T1-patch7 (2026-07-28): 拆分 identity → 身份/职业/处境 三个独立字段 + 新增 age / bio
      // T1-patch8 (2026-07-28): 新增角色弧光三字段 arcFrom / arcTo / arcType（方案 D）
      // T1-patch9 (2026-07-29): 新增 gender 字段
      return { id:this.uid(), role:'配角', name:'', age:'', gender:'', identity:'', occupation:'', situation:'', bio:'', desire:'', fear:'', likability:60, authorProjection:20, arcFrom:'', arcTo:'', arcType:'', backstory:'', fragments:[] };
    },
    blankCharacter() {
      // T1-patch5: 新增 modal 专用：首个角色默认主角，否则配角
      const c = this.newCharacter();
      if (this.data.characters.length === 0) c.role = '主角';
      return c;
    },
    addCharacter() {
      // T1-patch5: 旧入口保留 API（若有外部调用），内部改为开 modal
      this.openCharacterModal(null);
    },
    delCharacter(id) {
      // T1-patch5: 保留入口充当回退路径（目录树已不再直接删除）；仍用 window.confirm 作兼容兵（不推荐路径）。
      if (!confirm('删除这个角色？')) return;
      this.data.characters = this.data.characters.filter(x => x.id !== id);
      if (this.current.type === 'character' && this.current.id === id) this.select({ type:'characters-root' });
    },
    currentCharacter() {
      return this.data.characters.find(c => c.id === this.current.id);
    },
    roleEmoji(role) { return { '主角':'★', '配角':'☆', '反派':'☠' }[role] || '·'; },
    // T1-patch5 (2026-07-28): 三栏分组过滤
    charactersByRole(role) {
      return this.data.characters.filter(c => (c.role || '配角') === role);
    },
    // T1-patch5 (2026-07-28): 角色 modal（新增/编辑共用）
    openCharacterModal(id) {
      const isNew = !id;
      let target;
      if (isNew) {
        target = this.blankCharacter();
        // 新增时先不 push，保存才 push（取消则丢弃，无需回滚）
        this._pendingNewCharacter = target;
      } else {
        target = this.data.characters.find(c => c.id === id);
        if (!target) return;
        this._pendingNewCharacter = null;
      }
      // 深拷快照，排除 fragments（K师拍板：取消不回滚碎片池；且新模型下碎片池已不存于角色内）
      const snap = {};
      for (const k of Object.keys(target)) {
        if (k === 'fragments') continue;
        snap[k] = typeof target[k] === 'object' && target[k] !== null ? JSON.parse(JSON.stringify(target[k])) : target[k];
      }
      this.characterModal = { open:true, mode: isNew ? 'new' : 'edit', id: target.id, snapshot: snap, confirmDelete:false, isNew };
      // 新增时把 target 暂存到一个开放变量方便 modal 模板 x-data 引用
      // 策略：不管新增与否，都先 push 进去（UI 可直接指向），取消时才移除。
      if (isNew) {
        this.data.characters.push(target);
      }
      // 锁 body 滚动
      try { document.body.style.overflow = 'hidden'; } catch(e) {}
    },
    _characterModalTarget() {
      const id = this.characterModal.id;
      return this.data.characters.find(c => c.id === id);
    },
    saveCharacterModal() {
      // 直接落盘（当前表单绑定已写入）
      this.touchData();
      this.saveProjectData();
      this._closeCharacterModal(false);
    },
    cancelCharacterModal() {
      const id = this.characterModal.id;
      const snap = this.characterModal.snapshot;
      if (this.characterModal.isNew) {
        // 新增取消：从列表里移除（碎片池不回滚——新建角色本身无 fragments，但共享池已变也不退）
        this.data.characters = this.data.characters.filter(c => c.id !== id);
      } else if (snap) {
        // 编辑取消：回滚非 fragments 字段
        const target = this._characterModalTarget();
        if (target) {
          for (const k of Object.keys(snap)) {
            target[k] = snap[k];
          }
        }
      }
      // 取消后强制一次落盘，避免中途 debounce 自动保存残留
      this.saveProjectData();
      this._closeCharacterModal(false);
    },
    askDeleteCharacterInModal() {
      this.characterModal.confirmDelete = true;
    },
    cancelDeleteCharacterInModal() {
      this.characterModal.confirmDelete = false;
    },
    confirmDeleteCharacterInModal() {
      const id = this.characterModal.id;
      this.data.characters = this.data.characters.filter(c => c.id !== id);
      this.saveProjectData();
      this._closeCharacterModal(true);
      this.showToast('已删除角色');
    },
    _closeCharacterModal(_afterDelete) {
      this.characterModal = { open:false, mode:'edit', id:null, snapshot:null, confirmDelete:false, isNew:false };
      this._pendingNewCharacter = null;
      try { document.body.style.overflow = ''; } catch(e) {}
    },

    // ===== chapters =====
    newChapter(num) {
      return { id:this.uid(), number:num||(this.data.chapters.length+1), title:'', oneLine:'', pov:'', characters:[], keyScenes:'', fragments:[] };
    },
    addChapter() {
      const nextNum = this.data.chapters.length > 0 ? Math.max(...this.data.chapters.map(c=>c.number))+1 : 1;
      const ch = this.newChapter(nextNum);
      this.data.chapters.push(ch);
      this.select({ type:'chapter', id:ch.id });
    },
    delChapter(id) {
      if (!confirm('删除这一章？')) return;
      this.data.chapters = this.data.chapters.filter(x => x.id !== id);
      if (this.current.type === 'chapter' && this.current.id === id) this.select({ type:'chapters-root' });
    },
    moveChapter(idx, delta) {
      const j = idx + delta;
      if (j < 0 || j >= this.data.chapters.length) return;
      const arr = this.data.chapters;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      this.saveDebounced();
    },
    currentChapter() {
      return this.data.chapters.find(c => c.id === this.current.id);
    },
    toggleChChar(ch, name) {
      const i = ch.characters.indexOf(name);
      if (i >= 0) ch.characters.splice(i, 1); else ch.characters.push(name);
      this.touchData();
    },

    // ===== fragments =====
    addFragment() {
      const c = this.fragDraft.content.trim();
      if (!c) return;
      this.data.fragments.push({ id:this.uid(), type:this.fragDraft.type, content:c });
      this.fragDraft.content = '';
    },
    delFragment(id) {
      this.data.fragments = this.data.fragments.filter(x => x.id !== id);
    },

    // ===== genres =====
    toggleGenre(g) {
      const arr = this.data.project.genres;
      const i = arr.indexOf(g);
      if (i >= 0) arr.splice(i, 1); else arr.push(g);
      this.touchData('立项', '类型 '+g);
    },

    // ===== auto one-line =====
    autoOneLine() {
      const p = this.data.project;
      const hero = this.data.characters.find(c => c.role === '主角');
      const parts = [];
      if (hero?.identity) parts.push('一个'+hero.identity);
      else if (hero?.name) parts.push(hero.name);
      if (this.data.conflict.externalMain) parts.push('遭遇'+this.data.conflict.externalMain);
      if (hero?.desire) parts.push('渴望'+hero.desire);
      const s = parts.join('，');
      if (s) { p.oneLineStory = s; this.showToast('已生成 · 可以再改'); }
      else this.showToast('先填主角和冲突再生成');
    },

    // ===== status dots =====
    statusOf(section) {
      const map = {
        'project': ['title','oneLineStory','theme','readerProfile','lengthType'],
        'world':   ['era','place','worldRules','atmosphere','diffFromReality'],
        'conflict':['externalMain','internalMain','subConflict','climaxScene'],
        'message': ['coreMessage','whyNow'],
        'antilist':['avoidTropes','avoidHeroBecoming','avoidEndings'],
      };
      const fields = map[section];
      if (!fields) return 'empty';
      const obj = this.data[section];
      let filled = 0;
      fields.forEach(f => { if ((obj[f]||'').toString().trim() !== '') filled++; });
      if (section === 'project' && this.data.project.genres.length > 0) filled++;
      const total = fields.length + (section === 'project' ? 1 : 0);
      if (filled === 0) return 'empty';
      if (filled >= total) return 'green';
      return 'yellow';
    },
    statusOfCharacter(c) {
      // T1-patch7: bio 计入完成度；age/occupation/situation 不计入（避免老档突然全变红）
      const fields = ['name','identity','bio','desire','fear','backstory'];
      let filled = 0;
      fields.forEach(f => { if ((c[f]||'').toString().trim() !== '') filled++; });
      if (filled === 0) return 'empty';
      if (filled >= fields.length) return 'green';
      return 'yellow';
    },
    statusOfCharacters() {
      if (this.data.characters.length === 0) return 'empty';
      const all = this.data.characters.map(c => this.statusOfCharacter(c));
      if (all.every(s => s === 'green')) return 'green';
      return 'yellow';
    },
    statusOfChapter(ch) {
      const fields = ['title','oneLine','pov','keyScenes'];
      let filled = 0;
      fields.forEach(f => { if ((ch[f]||'').toString().trim() !== '') filled++; });
      if ((ch.characters||[]).length > 0) filled++;
      if (filled === 0) return 'empty';
      if (filled >= fields.length + 1) return 'green';
      return 'yellow';
    },
    statusOfChapters() {
      if (this.data.chapters.length === 0) return 'empty';
      const all = this.data.chapters.map(c => this.statusOfChapter(c));
      if (all.every(s => s === 'green')) return 'green';
      return 'yellow';
    },

    // ===== smart asks =====
    currentNodeText() {
      const t = this.current.type;
      if (t === 'project') return Object.values(this.data.project).flat().join(' ');
      if (t === 'world')   return Object.values(this.data.world).join(' ');
      if (t === 'conflict')return Object.values(this.data.conflict).join(' ');
      if (t === 'message') return Object.values(this.data.message).join(' ');
      if (t === 'antilist')return Object.values(this.data.antilist).join(' ');
      if (t === 'character') { const c = this.currentCharacter(); return c ? [c.name,c.gender,c.identity,c.occupation,c.situation,c.bio,c.desire,c.fear,c.arcFrom,c.arcTo,c.arcType,c.backstory].join(' ') : ''; }
      if (t === 'chapter')   { const c = this.currentChapter(); return c ? [c.title,c.oneLine,c.pov,c.keyScenes].join(' ') : ''; }
      return '';
    },
    rescanAsks() {
      const t = this.current.type;
      if (!['project','world','conflict','message','antilist','character','chapter'].includes(t)) return;
      const nodeKey = t === 'character' ? `character:${this.current.id}` : t === 'chapter' ? `chapter:${this.current.id}` : t;
      const text = this.currentNodeText();
      if (!text || text.trim().length < 4) return;
      // avoid re-scanning identical content
      if (this._lastAskScan[nodeKey] === text) return;
      this._lastAskScan[nodeKey] = text;

      const existingQs = new Set(this.asks.filter(a => a.targetKey === nodeKey).map(a => a.q));
      const hits = new Set();
      this.askRules.forEach(rule => {
        if (rule.kw.some(k => text.includes(k))) {
          rule.questions.forEach(q => hits.add(q));
        }
      });
      const newQs = [...hits].filter(q => !existingQs.has(q)).slice(0, 3);
      newQs.forEach(q => {
        this.asks.push({ id:this.uid(), q, targetKey:nodeKey, answering:false, answerText:'' });
      });
    },
    currentAsks() {
      const t = this.current.type;
      const key = t === 'character' ? `character:${this.current.id}` : t === 'chapter' ? `chapter:${this.current.id}` : t;
      return this.asks.filter(a => a.targetKey === key);
    },
    skipAsk(id) { this.asks = this.asks.filter(a => a.id !== id); },
    commitAsk(id) {
      const a = this.asks.find(x => x.id === id);
      if (!a || !a.answerText.trim()) return;
      const stamp = new Date().toISOString().slice(11,16);
      const appendText = `\n[${stamp}] Q: ${a.q}\nA: ${a.answerText.trim()}`;
      const t = this.current.type;
      if (t === 'character') {
        const c = this.currentCharacter();
        if (c) c.backstory = (c.backstory||'') + appendText;
      } else if (t === 'chapter') {
        const ch = this.currentChapter();
        if (ch) ch.keyScenes = (ch.keyScenes||'') + appendText;
      } else {
        const fieldMap = {
          'project':'oneLineStory','world':'worldRules','conflict':'externalMain',
          'message':'coreMessage','antilist':'avoidTropes',
        };
        const f = fieldMap[t];
        if (f) this.data[t][f] = (this.data[t][f]||'') + appendText;
      }
      this.asks = this.asks.filter(x => x.id !== id);
      this.showToast('已追加到当前节点');
      this.touchData();
    },

    // ===== brain dump =====
    // T1-patch2 (2026-07-27): 每板块独立碎片池——所有 Brain Dump 归档都改为 push 到对应 fragments 数组。
    // 全局 fragments 池保留原 {id,type,content} 结构；板块池用 {id,text,createdAt}。
    _resolveFragmentTarget(scope, extraKey) {
      if (scope === 'project') return this.data.project.fragments;
      if (scope === 'world') return this.data.world.fragments;
      if (scope === 'conflict') return this.data.conflict.fragments;
      if (scope === 'message') return this.data.message.fragments;
      if (scope === 'antilist') return this.data.antilist.fragments;
      if (scope === 'character') {
        // T1-patch5: 角色板块共享池（无视 extraKey，兼容遗留调用点）
        if (!Array.isArray(this.data.charactersPool)) this.data.charactersPool = [];
        return this.data.charactersPool;
      }
      if (scope === 'chapter') {
        const ch = this.data.chapters.find(x => x.id === extraKey);
        return ch ? ch.fragments : null;
      }
      return null;
    },
    _scopeLabel(scope) {
      return { project:'立项', world:'世界观', conflict:'冲突', message:'表达',
        antilist:'反面清单', character:'角色', chapter:'章节', fragments:'碎片池' }[scope] || scope;
    },
    deleteFragment(scope, idx, extraKey) {
      const target = this._resolveFragmentTarget(scope, extraKey);
      if (target && idx >= 0 && idx < target.length) {
        target.splice(idx, 1);
        // T1-patch4: 删空后自动补一张空白卡，保持「永远有地方写」
        this._ensureBlankIfEmpty(target);
        this.touchData();
      }
    },
    // 板块页用的碎片新增（Brain Dump 之外，如未来「归位到正文」也可复用）
    addSectionFragment(scope, text, extraKey) {
      const t = (text || '').trim();
      if (!t) return;
      const target = this._resolveFragmentTarget(scope, extraKey);
      if (!target) return;
      target.unshift({ id: this.uid(), text: t, createdAt: Date.now() });
      this.touchData();
    },
    // 相对时间格式化（手写，不引 dayjs）
    fmtTime(ts) {
      if (!ts) return '';
      const diff = Date.now() - ts;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
      if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前';
      return new Date(ts).toLocaleDateString('zh-CN');
    },
    submitDump() {
      const text = this.dumpText.trim();
      if (!text) return;
      const tgt = this.dumpTarget;

      // 全局默认碎片池：保留原 {id, type, content} 结构（跟碎片池板块页 UI 兼容）
      if (tgt === 'fragments') {
        this.data.fragments.unshift({ id:this.uid(), type:'灵感', content:text });
        this.showToast('已归档到碎片池');
      } else if (tgt.startsWith('character:')) {
        // T1-patch5: 归档到角色共享池（不再区分具体角色）
        const target = this._resolveFragmentTarget('character');
        if (target) {
          target.unshift({ id:this.uid(), text, createdAt: Date.now() });
          this.showToast('已归档到角色碎片池');
        }
      } else if (tgt.startsWith('chapter:')) {
        const id = tgt.split(':')[1];
        const target = this._resolveFragmentTarget('chapter', id);
        if (target) {
          target.unshift({ id:this.uid(), text, createdAt: Date.now() });
          const ch = this.data.chapters.find(x => x.id === id);
          const label = ch ? ('Ch' + String(ch.number).padStart(2,'0')) : '章节';
          this.showToast('已归档到 ' + label + ' 碎片池');
        }
      } else if (['project','world','conflict','message','antilist'].includes(tgt)) {
        const target = this._resolveFragmentTarget(tgt);
        if (target) {
          target.unshift({ id:this.uid(), text, createdAt: Date.now() });
          this.showToast('已归档到 ' + this._scopeLabel(tgt) + ' 碎片池');
        }
      }
      this.dumpText = '';
      this.dumpModal = false;
      this.touchData();
    },

    // ===== preview render =====
    renderPreview() {
      const d = this.data;
      const esc = (s) => this._esc(s);
      let h = '';
      h += `<h1>《${esc(d.project.title || '未命名')}》· 故事档案</h1>`;
      if (d.project.oneLineStory) h += `<blockquote>${esc(d.project.oneLineStory)}</blockquote>`;

      h += `<h2>📖 立项</h2><ul>`;
      const p = d.project;
      if (p.theme) h += `<li>核心命题：${esc(p.theme)}</li>`;
      if (p.genres.length) h += `<li>类型：${esc(p.genres.join(' / '))}</li>`;
      h += `<li>调性：冷峻↔温暖 ${p.toneWarmth} · 严肃↔戏谑 ${p.toneHumor}</li>`;
      if (p.readerProfile) h += `<li>目标读者：${esc(p.readerProfile)}</li>`;
      if (p.lengthType) h += `<li>篇幅：${esc(p.lengthType)}</li>`;
      if (!p.theme && !p.genres.length && !p.readerProfile && !p.lengthType) h += `<li class="empty">（暂无内容）</li>`;
      h += `</ul>`;

      h += `<h2>🌍 世界观</h2><ul>`;
      const w = d.world;
      if (w.era) h += `<li>时代：${esc(w.era)}</li>`;
      if (w.place) h += `<li>地点：${esc(w.place)}</li>`;
      if (w.worldRules) h += `<li>世界规则：${esc(w.worldRules)}</li>`;
      if (w.atmosphere) h += `<li>氛围：${esc(w.atmosphere)}</li>`;
      if (w.diffFromReality) h += `<li>不同点：${esc(w.diffFromReality)}</li>`;
      if (Object.values(w).every(v => !v)) h += `<li class="empty">（暂无内容）</li>`;
      h += `</ul>`;

      h += `<h2>🎭 角色</h2>`;
      if (d.characters.length === 0) h += `<div class="empty">（暂无角色）</div>`;
      d.characters.forEach(c => {
        h += `<h3 data-target='{"type":"character","id":"${c.id}"}' onclick='window._smcJump(this)'>${this.roleEmoji(c.role)} ${esc(c.role)} · ${esc(c.name||'（未命名）')}</h3><ul>`;
        if (c.age) h += `<li>年龄：${esc(c.age)}</li>`;
        if (c.gender) h += `<li>性别：${esc(c.gender)}</li>`;
        if (c.identity) h += `<li>身份：${esc(c.identity)}</li>`;
        if (c.occupation) h += `<li>职业：${esc(c.occupation)}</li>`;
        if (c.situation) h += `<li>处境：${esc(c.situation)}</li>`;
        if (c.bio) h += `<li>简介：${esc(c.bio)}</li>`;
        if (c.desire) h += `<li>欲望：${esc(c.desire)}</li>`;
        if (c.fear) h += `<li>恐惧：${esc(c.fear)}</li>`;
        h += `<li>读者好感 ${c.likability} · 作者投射 ${c.authorProjection}</li>`;
        // T1-patch8: 人物转变（有内容才输出）
        if (c.arcFrom || c.arcTo || c.arcType) {
          const label = c.arcType ? `转变（${esc(c.arcType)}）` : '转变';
          const from = c.arcFrom ? esc(c.arcFrom) : '（未定）';
          const to = c.arcTo ? esc(c.arcTo) : '（未定）';
          h += `<li>${label}：从 ${from} → 到 ${to}</li>`;
        }
        if (c.backstory) h += `<li>背景：${esc(c.backstory).replace(/\n/g,'<br>')}</li>`;
        h += `</ul>`;
      });

      h += `<h2>⚔️ 冲突</h2><ul>`;
      const cf = d.conflict;
      if (cf.externalMain) h += `<li>外部主冲突：${esc(cf.externalMain)}</li>`;
      if (cf.internalMain) h += `<li>内部主冲突：${esc(cf.internalMain)}</li>`;
      if (cf.subConflict) h += `<li>副冲突：${esc(cf.subConflict)}</li>`;
      if (cf.climaxScene) h += `<li>高潮场景：${esc(cf.climaxScene)}</li>`;
      if (Object.values(cf).every(v => !v)) h += `<li class="empty">（暂无内容）</li>`;
      h += `</ul>`;

      h += `<h2>📚 章节</h2>`;
      if (d.chapters.length === 0) h += `<div class="empty">（暂无章节）</div>`;
      d.chapters.forEach(ch => {
        h += `<h3 data-target='{"type":"chapter","id":"${ch.id}"}' onclick='window._smcJump(this)'>Ch${String(ch.number).padStart(2,'0')} · ${esc(ch.title||'（未命名）')}</h3><ul>`;
        if (ch.oneLine) h += `<li>一句话：${esc(ch.oneLine)}</li>`;
        if (ch.pov) h += `<li>POV：${esc(ch.pov)}</li>`;
        if (ch.characters.length) h += `<li>关联角色：${esc(ch.characters.join('、'))}</li>`;
        if (ch.keyScenes) h += `<li>关键场景：${esc(ch.keyScenes).replace(/\n/g,'<br>')}</li>`;
        h += `</ul>`;
      });

      h += `<h2>🎬 碎片池</h2>`;
      if (d.fragments.length === 0) h += `<div class="empty">（暂无碎片）</div>`;
      else {
        h += `<ul>`;
        d.fragments.forEach(f => { h += `<li>【${esc(f.type)}】${esc(f.content)}</li>`; });
        h += `</ul>`;
      }

      h += `<h2>🎯 表达</h2><ul>`;
      const m = d.message;
      if (m.coreMessage) h += `<li>核心讯息：${esc(m.coreMessage)}</li>`;
      if (m.whyNow) h += `<li>为什么现在写：${esc(m.whyNow)}</li>`;
      if (!m.coreMessage && !m.whyNow) h += `<li class="empty">（暂无内容）</li>`;
      h += `</ul>`;

      h += `<h2>🚫 反面清单</h2><ul>`;
      const a = d.antilist;
      if (a.avoidTropes) h += `<li>避开的套路：${esc(a.avoidTropes)}</li>`;
      if (a.avoidHeroBecoming) h += `<li>主角不能变成：${esc(a.avoidHeroBecoming)}</li>`;
      if (a.avoidEndings) h += `<li>结局不要：${esc(a.avoidEndings)}</li>`;
      if (Object.values(a).every(v => !v)) h += `<li class="empty">（暂无内容）</li>`;
      h += `</ul>`;

      // set up jump handler once
      if (!window._smcJump) {
        window._smcJump = (el) => {
          try {
            const t = JSON.parse(el.getAttribute('data-target'));
            window.dispatchEvent(new CustomEvent('mvs013:nav', { detail: t }));
          } catch(e) { console.error(e); }
        };
      }
      return h;
    },

    // ===== markdown =====
    markdown() {
      const d = this.data;
      let md = `# 《${d.project.title || '未命名'}》· 故事档案\n\n`;
      if (d.project.oneLineStory) md += `> ${d.project.oneLineStory}\n\n`;
      md += `## 📖 立项\n`;
      const p = d.project;
      if (p.theme) md += `- 核心命题：${p.theme}\n`;
      if (p.genres.length) md += `- 类型：${p.genres.join(' / ')}\n`;
      md += `- 调性：冷峻↔温暖 ${p.toneWarmth} · 严肃↔戏谑 ${p.toneHumor}\n`;
      if (p.readerProfile) md += `- 目标读者：${p.readerProfile}\n`;
      if (p.lengthType) md += `- 篇幅：${p.lengthType}\n`;

      md += `\n## 🌍 世界观\n`;
      const w = d.world;
      if (w.era) md += `- 时代：${w.era}\n`;
      if (w.place) md += `- 地点：${w.place}\n`;
      if (w.worldRules) md += `- 世界规则：${w.worldRules}\n`;
      if (w.atmosphere) md += `- 氛围：${w.atmosphere}\n`;
      if (w.diffFromReality) md += `- 跟现实不同：${w.diffFromReality}\n`;

      md += `\n## 🎭 角色\n`;
      d.characters.forEach(c => {
        md += `\n### ${c.role || '角色'} · ${c.name || '（未命名）'}\n`;
        if (c.age) md += `- 年龄：${c.age}\n`;
        if (c.gender) md += `- 性别：${c.gender}\n`;
        if (c.identity) md += `- 身份：${c.identity}\n`;
        if (c.occupation) md += `- 职业：${c.occupation}\n`;
        if (c.situation) md += `- 处境：${c.situation}\n`;
        if (c.bio) md += `- 简介：${c.bio}\n`;
        if (c.desire) md += `- 欲望：${c.desire}\n`;
        if (c.fear) md += `- 恐惧：${c.fear}\n`;
        md += `- 读者好感 ${c.likability} · 作者投射 ${c.authorProjection}\n`;
        // T1-patch8: 人物转变
        if (c.arcFrom || c.arcTo || c.arcType) {
          const label = c.arcType ? `转变（${c.arcType}）` : '转变';
          const from = c.arcFrom || '（未定）';
          const to = c.arcTo || '（未定）';
          md += `- ${label}：从 ${from} → 到 ${to}\n`;
        }
        if (c.backstory) md += `- 背景：\n  ${c.backstory.split('\n').join('\n  ')}\n`;
      });

      md += `\n## ⚔️ 冲突\n`;
      const cf = d.conflict;
      if (cf.externalMain) md += `- 外部主冲突：${cf.externalMain}\n`;
      if (cf.internalMain) md += `- 内部主冲突：${cf.internalMain}\n`;
      if (cf.subConflict) md += `- 副冲突：${cf.subConflict}\n`;
      if (cf.climaxScene) md += `- 高潮场景：${cf.climaxScene}\n`;

      md += `\n## 📚 章节\n`;
      d.chapters.forEach(ch => {
        md += `\n### Ch${String(ch.number).padStart(2,'0')} · ${ch.title || '（未命名）'}\n`;
        if (ch.oneLine) md += `- 一句话：${ch.oneLine}\n`;
        if (ch.pov) md += `- POV：${ch.pov}\n`;
        if (ch.characters.length) md += `- 关联角色：${ch.characters.join('、')}\n`;
        if (ch.keyScenes) md += `- 关键场景：\n  ${ch.keyScenes.split('\n').join('\n  ')}\n`;
      });

      md += `\n## 🎬 碎片池\n`;
      d.fragments.forEach(f => { md += `- 【${f.type}】${f.content}\n`; });

      md += `\n## 🎯 表达\n`;
      if (d.message.coreMessage) md += `- 核心讯息：${d.message.coreMessage}\n`;
      if (d.message.whyNow) md += `- 为什么现在写：${d.message.whyNow}\n`;

      md += `\n## 🚫 反面清单\n`;
      if (d.antilist.avoidTropes) md += `- 避开套路：${d.antilist.avoidTropes}\n`;
      if (d.antilist.avoidHeroBecoming) md += `- 主角不能变：${d.antilist.avoidHeroBecoming}\n`;
      if (d.antilist.avoidEndings) md += `- 结局不要：${d.antilist.avoidEndings}\n`;
      return md;
    },
    async copyMd() {
      try { await navigator.clipboard.writeText(this.markdown()); this.showToast('已复制 ✓'); }
      catch(e) {
        const ta = document.createElement('textarea'); ta.value = this.markdown();
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); this.showToast('已复制 ✓'); } catch(_) { this.showToast('复制失败'); }
        document.body.removeChild(ta);
      }
    },
    downloadMd() {
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
      const blob = new Blob([this.markdown()], { type:'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `story-${(this.data.project.title||'untitled').replace(/[^\w一-龥]/g,'_')}-${stamp}.md`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 500);
      this.showToast('已下载 ✓');
    },

    showToast(msg) {
      this.toast = msg;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => this.toast = '', 1800);
    },
  };
}
