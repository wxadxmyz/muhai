import React from 'react';
import ReactDOM from 'react-dom/client';
import VideoApp from './VideoApp';
import { ThemeProvider } from '../lib/theme';
import { ToastProvider } from '../lib/toast';
import '../styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <VideoApp />
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>
);
