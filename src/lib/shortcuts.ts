import { useEffect } from 'react';
import { player } from './playerStore';
import { initMediaSession } from './mediaSession';
import { registerGlobalShortcuts } from './tauriBridge';

// 窗口聚焦时快捷键（应用内）：空格 播放/暂停、←→ 进退、↑↓ 音量、M 静音、N/P 上下首。
// 注：窗口失焦/最小化时此监听不生效；真·全局(窗口失焦仍可用)由桌面端 Tauri 全局快捷键插件补充。
export function useGlobalShortcuts() {
  useEffect(() => {
    // P2-11 锁屏/后台媒体控制（纯 Web，Tauri WebView 与浏览器通用）
    initMediaSession();
    // P2-13 真·全局快捷键：窗口失焦时仍可用媒体键控制播放（仅 Tauri 桌面端生效）
    registerGlobalShortcuts({
      toggle: () => player.toggle(),
      next: () => player.next(),
      prev: () => player.prev(),
    });

    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const s = player.getState();
      // V4.5.7 #15：焦点浮层（选集/设置/简介等带 data-focus-root）打开时，方向键交给焦点导航，
      // 本监听不得再 seek —— 否则选集浮窗按左右键会同时快进/快退画面。
      // 注意：外壳根容器 .tv 也带 data-focus-root，必须排除，否则会被误判成浮层导致快进永久失效。
      const focusOverlayOpen = !!Array.from(document.querySelectorAll<HTMLElement>('[data-focus-root]')).some((el) => {
        if (el.classList.contains('tv')) return false; // 外壳根，不是浮层
        const cs = getComputedStyle(el);
        return cs.position === 'fixed' || cs.display !== 'none';
      });
      switch (e.key) {
        case ' ':
          if (focusOverlayOpen) break;
          e.preventDefault();
          player.toggle();
          break;
        case 'ArrowLeft':
          if (focusOverlayOpen) break;
          if (s.current) player.seek(Math.max(0, s.progress - 5));
          break;
        case 'ArrowRight':
          if (focusOverlayOpen) break;
          if (s.current) player.seek(Math.min(s.duration || 1e9, s.progress + 5));
          break;
        case 'ArrowUp':
          e.preventDefault();
          player.setVolume(Math.min(1, s.volume + 0.05));
          break;
        case 'ArrowDown':
          e.preventDefault();
          player.setVolume(Math.max(0, s.volume - 0.05));
          break;
        case 'm':
        case 'M':
          player.setMuted(!s.muted);
          break;
        case 'n':
        case 'N':
          player.next();
          break;
        case 'p':
        case 'P':
          player.prev();
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
