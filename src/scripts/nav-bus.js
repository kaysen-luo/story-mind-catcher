// MVS-013 · v1.0 · 事件总线包装
// v0.3.1 里预览 h3 onclick 会 dispatch CustomEvent('mvs013:nav', {detail:{type,id}}),
// app.init 里 window.addEventListener 接住。
// 这里 export 一个薄封装供未来非全局用；v0.3.1 兼容 window.dispatchEvent 保留。
export const NAV_EVENT = 'mvs013:nav';

export function emitNav(target) {
  window.dispatchEvent(new CustomEvent(NAV_EVENT, { detail: target }));
}

export function onNav(handler) {
  window.addEventListener(NAV_EVENT, (e) => {
    if (e && e.detail) handler(e.detail);
  });
}
