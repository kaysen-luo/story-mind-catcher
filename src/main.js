// MVS-013 · v1.0 · Alpine 启动 + store 装配
// 顺序：
//   1. 引入所有 CSS（Vite 会打包）
//   2. import Alpine + createApp
//   3. window.Alpine = Alpine（方便调试 / 兼容 devtools）
//   4. Alpine.data('app', createApp) —— 匹配 body x-data="app"
//   5. Alpine.start()

import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/theme-dark.css';

import Alpine from 'alpinejs';
import { createApp } from './scripts/app.js';

window.Alpine = Alpine;
Alpine.data('app', createApp);
Alpine.start();
