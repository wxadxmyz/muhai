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
  // v2.3.0 加密源解密（E5）：调用第三方解密端点还原加密接口（如饭太硬 jiemi.php）
  decryptEnabled: boolean; // 是否启用服务端解密
  decryptEndpoint: string; // 解密端点地址（可在设置里改/关）
}

const KEY = 'mps_settings';

// 加密源解密默认端点（饭太硬 jiemi.php，服务端解密，无需私有 key）
export const DEFAULT_DECRYPT_ENDPOINT = 'http://www.xn--sss604efuw.cc/jm/jiemi.php';

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
  decryptEnabled: true,
  decryptEndpoint: DEFAULT_DECRYPT_ENDPOINT,
};

// 非 hook 读取解密配置（供引擎模块如 tvbox.ts 在非组件上下文中使用）。
// 从 localStorage 读取，缺省回退到默认值。
export function getDecryptConfig(): { enabled: boolean; endpoint: string } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return {
        enabled: s.decryptEnabled !== false,
        endpoint: s.decryptEndpoint || DEFAULT_DECRYPT_ENDPOINT,
      };
    }
  } catch {
    /* ignore */
  }
  return { enabled: true, endpoint: DEFAULT_DECRYPT_ENDPOINT };
}

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
