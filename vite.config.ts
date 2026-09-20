import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// #15 版本号自动化：package.json 为「单一真源」。
// - 前端资源缓存戳（?v=）与 __APP_VERSION__ 都从这里读；
// - tauri.conf.json / Cargo.toml 由 `npm run version:sync`（scripts/sync-version.mjs）同步。
function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
    if (pkg?.version) return String(pkg.version);
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

const VER = appVersion();

// 单入口：幕海 App（video.html）
export default defineConfig({
  // 把版本号注入前端（避免在 SettingsPage 等处以 fallback 常量硬编码写死）
  define: {
    __APP_VERSION__: JSON.stringify(VER),
  },
  plugins: [
    react(),
    {
      // 给打包后的 CSS/JS 引用追加 ?v=<version>，强制缓存失效
      name: 'asset-version-stamp',
      transformIndexHtml(html) {
        return html.replace(/(href|src)="(\/assets\/[^"]+)"/g, (_m, attr, p) => {
          const sep = p.includes('?') ? '&' : '?';
          return `${attr}="${p}${sep}v=${VER}"`;
        });
      },
    },
  ],
  server: { host: true, port: 5173 },
  build: {
    rollupOptions: {
      input: {
        video: resolve(__dirname, 'video.html'),
      },
    },
  },
});
