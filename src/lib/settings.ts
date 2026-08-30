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
  // v1.2.1 新增
  disclaimerAccepted: boolean; // 是否已同意免责声明（首次启动）
  darkMode: boolean; // 深色模式
  themeColor?: string; // 主题强调色
  wallpaper?: string; // 首页壁纸地址
  defaultPlayer: 'internal' | 'external'; // 默认播放器
  hardwareDecode: boolean; // 硬解/软解
  playbackRateMemory: boolean; // 倍速记忆开关
  autoDetectLine: boolean; // 线路自动探测
  autoSkipIntroOutro: boolean; // 自动跳过片头片尾（总开关）
  // ⑬ 首页国产过滤黑名单：标题含这些词的影视视为「非国产内地」予以屏蔽（可在设置里增删）
  blocklist: string[];
}

const KEY = 'mps_settings';

/** ⑬ 首页国产过滤默认屏蔽词：源无地区字段时，标题命中任一词即视为「非国产内地」 */
export const DEFAULT_BLOCKLIST = [
  '韩', '美', '日', '泰', '英', '法', '俄', '德', '意', '西', '印', '欧',
  '动漫', '海外', '韩剧', '美剧', '日剧', '泰剧', '英剧', '法剧', '韩综', '美综', '日综', '印度剧', '欧美', '日韩',
];

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
  disclaimerAccepted: false,
  darkMode: true,
  themeColor: undefined,
  wallpaper: undefined,
  defaultPlayer: 'internal',
  hardwareDecode: true,
  playbackRateMemory: true,
  autoDetectLine: false,
  autoSkipIntroOutro: false,
  blocklist: [...DEFAULT_BLOCKLIST],
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
