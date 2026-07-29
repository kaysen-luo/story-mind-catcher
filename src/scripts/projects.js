// MVS-013 · v1.0 · projects 分组占位
// T1 阶段：多档管理逻辑（createProject / switchProject / duplicateProject / exportProject /
// deleteProject / resumeProject / newProjectRecord / sortedProjects / autoDropEmptyCurrent
// / toggleCardMenu / startRename / commitRename / relTime / askDeleteProject / confirmDeleteProject）
// 全部整体保留在 app.js 中以保证 this 绑定与业务零回归。
// T6 会把这些方法真正搬到本文件，导出为 partial store，供 main.js 展开合并。
export {};
