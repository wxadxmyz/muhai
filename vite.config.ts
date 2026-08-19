import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// 单入口：幕海 App（video.html）
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  build: {
    rollupOptions: {
      input: {
        video: resolve(__dirname, 'video.html'),
      },
    },
  },
});
