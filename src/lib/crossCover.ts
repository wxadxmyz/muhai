// V3.3.5 B4：多源封面回退——LZ 等源图床在部分用户网络被整体阻断（实锤：img.lzipic.com
// 走阿里云海外 CDN 被运营商断），本源封面全灭且 app 层单源无解。
// 这里用当前片名到其它已启用源搜同名剧，取其封面 URL 只做展示层回填
// （不落库、不改原条目数据），全部失败才落到现有文字占位卡。
import { createSource, expandSources } from '../engine';
import type { SourceConfig, MediaItem } from '../engine/types';
import { withTimeout } from '../engine/http';
import { getDoubanCoverMap, normalizeTitle, refreshDoubanCoverMap } from './hot';

// 片名 → 封面URL。'' 表示「已跨源找过、没有可用的」，防止同一部片反复触发跨源搜索。
const cache = new Map<string, string>();
let inflight: { title: string; p: Promise<string> } | null = null;

/** 同会话内已查过的直接返回（进播放页时先查它，命中就不再跨源搜索） */
export function cachedCrossCover(title: string): string | undefined {
  return cache.get((title || '').trim());
}

/** 跨源找同名封面；找不到/全部源失败返回 '' */
export async function crossSourceCover(title: string, sources: SourceConfig[]): Promise<string> {
  const key = (title || '').trim();
  if (!key) return '';
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (inflight && inflight.title === key) return inflight.p;

  const p = (async (): Promise<string> => {
    try {
      // expandSources：tvbox 聚合源展开成蜘蛛子源（内部已按 enabled 过滤、按优先级排序）
      const usable = await expandSources(sources);
      // 并发搜所有源，任一源带回「同名且带封面」的条目即用（8s 超时防拖死播放页）
      const results = await Promise.all(
        usable.map(async (s): Promise<string> => {
          try {
            const items = await withTimeout(createSource(s).search(key, 1), 8000);
            const same = items.find(
              (it: MediaItem) =>
                it.mediaType === 'video' &&
                it.cover &&
                (it.title === key || it.title.includes(key) || key.includes(it.title))
            );
            return same?.cover ?? '';
          } catch {
            return ''; // 单源失败不影响其它源
          }
        })
      );
      const url = results.find(Boolean) ?? '';
      cache.set(key, url);
      return url;
    } catch {
      return '';
    }
  })();

  inflight = { title: key, p };
  return p;
}

// V3.3.8：已尝试回退的 key（跨页去重，避免同一部剧反复跨源搜索）
const triedFallback = new Set<string>();

/**
 * V3.3.8：封面回退统一入口——主源封面加载失败时调用。
 * 优先级：豆瓣同名封面（单源 / 图床不通时救急，不依赖其它源）→ 跨源同名封面（配多源时生效）。
 * 任一命中即通过 onResolved 回填展示封面；全部失败则保持原文字兜底。
 */
export function tryCoverFallback(opts: {
  key: string;
  title: string;
  allSources: SourceConfig[];
  onResolved: (url: string) => void;
}): void {
  const { key, title, allSources, onResolved } = opts;
  if (triedFallback.has(key)) return;
  triedFallback.add(key);
  const norm = normalizeTitle(title);
  // 1) 豆瓣同名兜底（首页热榜已拉豆瓣图，用户手机可达）
  const db = getDoubanCoverMap().get(norm);
  if (db) { onResolved(db); return; }
  // 热榜缓存为空时异步补全一次，命中再回填（不阻塞当前渲染）
  refreshDoubanCoverMap().then((m) => {
    const u = m.get(norm);
    if (u) onResolved(u);
  });
  // 2) 跨源同名兜底（配多源时生效）
  crossSourceCover(title, allSources).then((u) => { if (u) onResolved(u); });
}
