import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// MVS-013 v1.0 T3 · Vite + PWA
// - root 指向 src/ (index.html 在 src/ 下)
// - public/ 保留 robots.txt / icons/ 等静态资源
// - PWA: vite-plugin-pwa · autoUpdate · 应用外壳 precache
// - dev 模式下 SW 关闭（devOptions.enabled=false），不污染 HMR
export default defineConfig({
  root: 'src',
  publicDir: '../public',
  server: {
    port: 5173,
    strictPort: false,
    open: false,
    host: true,
    // 允许 cloudflared 临时隧道访问（K师跨设备验收用）
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.io'],
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  plugins: [
    VitePWA({
      // 自动检测新版本 SW 并激活；配合 src/pwa.js 里 reload 逻辑避免旧版本卡死
      registerType: 'autoUpdate',
      injectRegister: false, // 我们在 src/pwa.js 里手动注册，方便挂 updatefound 逻辑
      // 输出到 dist 根，配合 Cloudflare Pages 根路径部署
      strategies: 'generateSW',
      workbox: {
        // 应用外壳 precache：HTML/JS/CSS/图标/manifest 全进
        globPatterns: ['**/*.{html,js,css,ico,png,svg,webmanifest}'],
        // SW 一激活立刻接管旧 client + skipWaiting，配合 registerType:autoUpdate
        clientsClaim: true,
        skipWaiting: true,
        // 用户数据在 IndexedDB / LocalStorage，不经过 fetch，无需运行时缓存策略
        // 若后续引入外部字体/CDN，再补 runtimeCaching
        cleanupOutdatedCaches: true,
      },
      includeAssets: [
        'robots.txt',
        'icons/apple-touch-icon.png',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/icon-512-maskable.png',
      ],
      manifest: {
        name: 'Story Mind Catcher · 小说架构编辑器',
        short_name: '小说架构',
        description: '离线优先的小说架构编辑器：三段式布局 + 9 板块 + 多档管理',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // 不锁定方向：作者可能横屏用
        // orientation intentionally omitted
        theme_color: '#14141c',
        background_color: '#14141c',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // dev 模式下不注册 SW，避免污染 K师 HMR 冒烟流程
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
