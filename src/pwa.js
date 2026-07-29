// MVS-013 v1.0 T3 · PWA 注册入口
// - 只在 production build 里生效（vite-plugin-pwa 的 virtual:pwa-register 在 dev 会 no-op）
// - registerType: 'autoUpdate' + skipWaiting + clientsClaim（vite.config.js）
//   → 新 SW 一装完就立刻接管，配合下方 reload 逻辑，杜绝「用户看到旧版本卡住」的经典 PWA 坑
// - dev 环境下 SW 已在 vite.config.js 关闭（devOptions.enabled=false），本文件的 register 也 no-op
//
// 触发条件：
//   1. 首次访问：SW 装完就控制页面，下次刷新走缓存
//   2. 后续版本发布：workbox 拉到新 sw.js → skipWaiting 立即激活
//      → controllerchange 事件触发 → 我们做一次 reload，确保用户拿到新代码
//
// 注意：`window.__mvs013SwReloaded` 防重入（部分浏览器会连发两次 controllerchange）

import { registerSW } from 'virtual:pwa-register';

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // autoUpdate 下不会走这里；保留是为了将来切成 prompt 模式时有钩子
    // console.info('[PWA] new content available');
  },
  onOfflineReady() {
    // console.info('[PWA] app ready to work offline');
  },
  onRegisteredSW(swUrl) {
    // console.info('[PWA] SW registered:', swUrl);
  },
  onRegisterError(err) {
    console.warn('[PWA] SW register failed:', err);
  },
});

// 新 SW 通过 skipWaiting+clientsClaim 立刻接管后，浏览器抛 controllerchange
// 立刻 reload 一次，用户就看到新版本，不会卡在旧壳
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (window.__mvs013SwReloaded) return;
    window.__mvs013SwReloaded = true;
    // 微延迟确保新 SW 完全接管；同时避免和 Alpine.start() 打架
    setTimeout(() => window.location.reload(), 50);
  });
}

// 若将来要做 UI 提示条（"发现新版本，点这里更新"），把 registerType 改回 'prompt'
// 并在 onNeedRefresh 里 dispatch 一个自定义事件给 Alpine 展示 toast，再手动 updateSW(true)。

export { updateSW };
