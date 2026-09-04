import React from 'react';
import ReactDOM from 'react-dom/client';
import VideoApp from './VideoApp';
import { ThemeProvider } from '../lib/theme';
import { ToastProvider } from '../lib/toast';
import { installSafeAreaFallback } from '../lib/safeArea';
import { syncNetdiskTokens } from '../lib/netdisk';
import '../styles.css';

installSafeAreaFallback();
// 选项 B（V3.2.5）：启动时消费网盘登录经 URL query 回传的 token（主 WebView 跳回 App 时带入）
syncNetdiskTokens();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <VideoApp />
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>
);
