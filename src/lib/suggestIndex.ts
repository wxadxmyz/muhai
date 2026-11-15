// V4.3.8：TV 搜索联想「源片名预热索引」。
//
// 背景：旧版 TV 搜索联想只认「热榜 + 搜索历史」，不覆盖用户添加源里的片名。
// 遥控器输拼音首字母（如 dsj）时，源站搜索接口只认中文关键词、拼音发过去基本为空，
// 且逐字查源会卡死。故改为：软件启动时后台把各源首页片名拉下来，构建成本地拼音索引，
// 之后输首字母即可秒出源里的片名——离线、不卡、覆盖常见片。
//
// 冷门片联想不到属预期，按「搜索」键仍会走 aggregateSearch 全站查源兜底。

import { aggregateHomeCached, type SourceConfig } from '../engine';
import { buildPinyinIndex, type PinyinEntry } from './pinyinSearch';

const CACHE_KEY = 'muhai_tv_suggest_v1';
let cache: PinyinEntry[] | null = null;
const listeners = new Set<() => void>();

/** 读取本地索引（内存 → localStorage）。同步返回，供渲染直接用。 */
export function loadSuggestIndex(): PinyinEntry[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.names)) cache = buildPinyinIndex(obj.names.filter((x: any) => typeof x === 'string'));
    }
  } catch {
    /* ignore */
  }
  return cache ?? [];
}

/** 订阅索引更新（预热完成后通知 SearchTV 重算）。返回取消订阅函数。 */
export function subscribeSuggest(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 软件启动时后台预热：拉取各源首页片名 → 建拼音索引 → 缓存并通知。 */
export async function prewarmSuggestIndex(sources: SourceConfig[]): Promise<number> {
  const active = (sources || []).filter((s) => s.enabled);
  if (!active.length) return 0;
  try {
    const r = await aggregateHomeCached(active, { timeout: 12000, limit: 60 });
    const names = Array.from(new Set(r.items.map((i) => (i.title || '').trim()).filter(Boolean)));
    if (names.length) {
      cache = buildPinyinIndex(names);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), names })); } catch { /* ignore */ }
      listeners.forEach((f) => { try { f(); } catch { /* ignore */ } });
    }
    return names.length;
  } catch {
    return 0;
  }
}
