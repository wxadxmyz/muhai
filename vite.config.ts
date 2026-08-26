import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// 读取 tauri.conf.json 的 version，作为前端资源缓存戳。
// 每次发版 version 变化 → 资源 URL 带新 ?v= → 强制 WebView 丢弃旧缓存重新加载，
// 杜绝"APK 升了但前端还是旧壳"的问题。
function appVersion(): string {
  try {
    const raw = readFileSync(resolve(__dirname, 'src-tauri/tauri.conf.json'), 'utf-8');
    const m = raw.match(/"version"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

const VER = appVersion();

// 单入口：幕海 App（video.html）
export default defineConfig({
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
