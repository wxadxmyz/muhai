import { player, usePlayer } from './playerStore';
import { resolvePlay } from '../player';
import { resolvePlayUrl } from '../engine/adapters/normal';
import { MediaItem, SourceConfig } from '../engine/types';
import { useLibrary } from './library';

// 统一的「播放一个 / 播放一整列」逻辑，供音乐与影视两端复用
export function usePlayback(sources: SourceConfig[], library: ReturnType<typeof useLibrary>) {
  // 订阅一次，保证组件在 player 状态变化时刷新
  usePlayer();

  const play = async (item: MediaItem, queue?: MediaItem[], index = 0) => {
    library.addHistory(item);
    if (queue && queue.length) player.playQueue(queue, index);
    else player.playItem(item);
  };

  const playList = (items: MediaItem[], index = 0) => {
    if (!items.length) return;
    library.addHistory(items[Math.max(0, Math.min(index, items.length - 1))]);
    player.playQueue(items, index);
  };

  return { play, playList };
}

// 媒体元素（audio/video）共用的解析逻辑：current 变化时按需取直链并播放
export function useMediaResolver(sources: SourceConfig[]) {
  const state = usePlayer();

  // 媒体直链（含标准 master m3u8）：命中即直接交给播放器，不浪费一次解析请求
  const MEDIA_RE = /\.(m3u8|mp4|mp3|flac|aac|wav|m4a|ogg|webm|mov|mkv)(\?|$)/i;

  const ensureResolved = async (item: MediaItem) => {
    const url = item.playUrl;
    if (url && MEDIA_RE.test(url)) return item;
    // 非直链（如量子/lzi 分享页 URL）：先走一次分享页解析，拿到真实 m3u8 再播
    if (url) {
      try {
        const r = await resolvePlayUrl(url);
        if (r && r !== url) {
          const resolved = { ...item, playUrl: r };
          player.updateCurrent(resolved);
          return resolved;
        }
      } catch {
        /* 解析失败则回退到按源重新拉详情 */
      }
    }
    // 没有地址、或分享页解析不出：按源重新拉详情解析播放地址
    try {
      const r = await resolvePlay(item, sources);
      player.updateCurrent(r);
      return r;
    } catch {
      return item;
    }
  };

  return { state, ensureResolved };
}
