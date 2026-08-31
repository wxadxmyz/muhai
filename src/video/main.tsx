import React from 'react';
import ReactDOM from 'react-dom/client';
import VideoApp from './VideoApp';
import { ThemeProvider } from '../lib/theme';
import { ToastProvider } from '../lib/toast';
import { installSafeAreaFallback } from '../lib/safeArea';
import '../styles.css';

installSafeAreaFallback();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <VideoApp />
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>
);
