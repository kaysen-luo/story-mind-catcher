// MVS-013 · v1.0 · 常量集中
// 收编 v0.3.1 里散落的 STORAGE key + 9 板块元数据 + 类型选项。
// T2 迁 IDB 时 STORAGE key 常量仍保留（迁移脚本用）。

export const STORAGE = {
  PROJECTS: 'mvs-013-projects',
  CURRENT: 'mvs-013-current',
  SORT: 'mvs-013-project-sort',
  PROJECT_PREFIX: 'mvs-013-project-',
  LEFT_COLLAPSED: 'mvs-013-left-collapsed',
  RIGHT_COLLAPSED: 'mvs-013-right-collapsed',
  // T1-patch5 (2026-07-28): 「不再提醒」开关——碎片删除的二次确认全局跳过标记
  SKIP_FRAG_DELETE_CONFIRM: 'mvs-013-skip-frag-delete-confirm',
};

export const GENRE_OPTIONS = [
  '科幻', '奇幻', '悬疑', '推理', '爱情', '言情', '都市',
  '历史', '武侠', '校园', '职场', '惊悚', '悬念', '文学', '青春',
];

// 9 板块元数据（v0.3.1 tree 顺序）
export const SECTIONS = [
  { type: 'project',          emoji: '📖', name: '立项' },
  { type: 'world',            emoji: '🌍', name: '世界观' },
  { type: 'characters-root',  emoji: '🎭', name: '角色' },
  { type: 'conflict',         emoji: '⚔️', name: '冲突' },
  { type: 'chapters-root',    emoji: '📚', name: '章节' },
  { type: 'fragments',        emoji: '🎬', name: '碎片池' },
  { type: 'message',          emoji: '🎯', name: '表达' },
  { type: 'antilist',         emoji: '🚫', name: '反面清单' },
  { type: 'projects',         emoji: '📚', name: '已立项目' },
];
