import { useEffect, useState } from 'react';

export interface AppSettings {
  downloadDir: string;
  defaultQuality: 'standard' | 'high' | 'lossless';
  autoNext: boolean; // 播放/观看完毕自动下一首/集
  saveHistory: boolean; // 记录播放/观看历史
  skipIntro: number; // 片头跳过秒数（影视）
  skipOutro: number; // 片尾提前结束秒数（影视）
  enableDanmaku: boolean; // 弹幕
  enableSubtitle: boolean; // 字幕
  showDesktopLyric: boolean; // 桌面歌词浮窗（音乐）
  notifyDownload: boolean; // 下载完成系统通知（桌面端 Tauri 通知插件）
  playbackRate: number; // 倍速记忆（0.5~2.0）
  skipByItem: Record<string, { intro: number; outro: number }>; // 按影视记忆的跳过片头/片尾（秒）
  subtitleStyle: { size: number; color: string; position: 'bottom' | 'top'; outline: boolean; bg: boolean }; // 字幕样式（影视）
}

const KEY = 'mps_settings';

const DEFAULTS: AppSettings = {
  downloadDir: '~/Downloads',
  defaultQuality: 'high',
  autoNext: true,
  saveHistory: true,
  skipIntro: 0,
  skipOutro: 0,
  enableDanmaku: true,
  enableSubtitle: true,
  showDesktopLyric: false,
  notifyDownload: true,
  playbackRate: 1,
  skipByItem: {},
  subtitleStyle: { size: 24, color: '#ffffff', position: 'bottom', outline: true, bg: false },
};

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      /* ignore */
    }
    return DEFAULTS;
  });

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(settings));
  }, [settings]);

  const update = (patch: Partial<AppSettings>) => setSettings((s) => ({ ...s, ...patch }));

  return { settings, update };
}
