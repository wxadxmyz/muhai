// P2-11 锁屏 / 后台媒体控制（纯 Web，Tauri WebView 与桌面浏览器通用）
// 订阅全局 player 状态机，把当前曲目/播放状态同步到 navigator.mediaSession，
// 使 Windows 任务栏、macOS 控制中心、安卓锁屏都能显示封面与控制。
import { player, fmtTime } from './playerStore';
import type { MediaItem } from '../engine/types';

let started = false;
let lastId: string | null = null;

function hasMediaSession(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

function artworkFor(item: MediaItem): MediaMetadataInit['artwork'] {
  if (!item.cover) return [];
  // 仅接受可被系统读取的 http(s) 封面；data: 也可但体积大，交给浏览器自行决定
  if (/^https?:\/\//i.test(item.cover) || item.cover.startsWith('data:')) {
    return [{ src: item.cover, sizes: '512x512', type: 'image/png' }];
  }
  return [];
}

function syncMetadata(item: MediaItem) {
  if (!hasMediaSession()) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title || '未知标题',
      artist: item.artist || item.sourceName || '未知艺术家',
      album: item.album || '',
      artwork: artworkFor(item),
    });
  } catch {
    /* 某些 WebView 对 artwork 限制较严，忽略即可 */
  }
}

function syncPlayback(s: ReturnType<typeof player.getState>) {
  if (!hasMediaSession()) return;
  try {
    navigator.mediaSession.playbackState = s.isPlaying ? 'playing' : 'paused';
  } catch {
    /* ignore */
  }
  try {
    if (s.duration > 0 && isFinite(s.duration)) {
      navigator.mediaSession.setPositionState({
        duration: s.duration,
        position: Math.min(Math.max(s.progress, 0), s.duration),
        playbackRate: 1,
      });
    }
  } catch {
    /* ignore */
  }
}

// 全局只需注册一次动作处理器
function registerActions() {
  if (!hasMediaSession()) return;
  const set = (a: MediaSessionAction, fn: (d: MediaSessionActionDetails) => void) => {
    try {
      navigator.mediaSession.setActionHandler(a, fn as any);
    } catch {
      /* 该平台不支持此动作，忽略 */
    }
  };
  set('play', () => { if (!player.getState().isPlaying) player.toggle(); });
  set('pause', () => { if (player.getState().isPlaying) player.toggle(); });
  set('previoustrack', () => player.prev());
  set('nexttrack', () => player.next());
  set('seekbackward', (d) => player.seek(Math.max(0, player.getState().progress - (d.seekOffset || 10))));
  set('seekforward', (d) => player.seek(player.getState().progress + (d.seekOffset || 10)));
  set('seekto', (d) => { if (d.seekTime != null) player.seek(d.seekTime); });
  set('stop', () => player.clearQueue());
}

/**
 * 初始化锁屏媒体控制。幂等，可在 App 启动时调用一次。
 */
export function initMediaSession(): void {
  if (started || !hasMediaSession()) return;
  started = true;
  registerActions();
  const apply = () => {
    const s = player.getState();
    if (s.current) {
      if (s.current.id !== lastId) {
        lastId = s.current.id;
        syncMetadata(s.current);
      }
      syncPlayback(s);
    } else {
      lastId = null;
      try { navigator.mediaSession.metadata = null; } catch { /* ignore */ }
    }
  };
  player.subscribe(apply);
  apply();
}

export { fmtTime };
