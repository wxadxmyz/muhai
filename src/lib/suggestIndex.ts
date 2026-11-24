// V4.4.5 A 方案：TV 搜索联想「全站片名索引」。
//
// 旧版只认「热榜 + 搜索历史 + 各源首页片名」，冷门片（如「非诚勿扰」）不在热榜就永远联想不到。
// 现在改为启动预热时：
//   ① 拉各源首页片名（老逻辑，limit 60 → 120）；
//   ② 用热榜 4 类各 10 部当关键词，跑「一轮全站搜索」，把返回片名并入索引；
//   ③ 合并去重 → 拼音首字母索引 → 缓存本地。
// 另外：用户在结果页每搜一次（aggregateSearch 返回），结果片名也增量并入索引（搜过即能联想）。
// 全部后台异步、本地缓存，不阻塞 UI；输首字母仍秒出。逐键查源会卡死，故不做实时查源。
// 注：搜索历史由 SearchTV 自己并入 indexes，这里不再重复读取。

import { aggregateHomeCached, aggregateSearch, type SourceConfig } from '../engine';
import { fetchHot } from './hot';
import { buildPinyinIndex, type PinyinEntry } from './pinyinSearch';

const CACHE_KEY = 'muhai_tv_suggest_v1';
// V4.5.0 云端词库：复用已绑定的 hot.json 路由 + ?suggest=1（Worker 每日 cron 自动更新）。
// 内置经典片名 + 豆瓣各榜，新片无需升级 APK 即可联想。
const CLOUD_SUGGEST_URL = 'https://wu2000.top/hot.json?suggest=1';
const CLOUD_CACHE_KEY = 'muhai_tv_suggest_cloud_v1';
const CLOUD_TTL = 12 * 60 * 60 * 1000;
let cache: PinyinEntry[] | null = null;
let cacheNames: string[] | null = null;
const listeners = new Set<() => void>();

/** 读取本地索引（内存 → localStorage）。同步返回，供渲染直接用。 */
export function loadSuggestIndex(): PinyinEntry[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.names)) {
        const names: string[] = obj.names.filter((x: any) => typeof x === 'string');
        cacheNames = names;
        cache = buildPinyinIndex(names);
      }
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

function commitNames(names: string[]): number {
  const uniq = Array.from(new Set(names.map((n) => (n || '').trim()).filter(Boolean)));
  if (!uniq.length) return 0;
  cacheNames = uniq;
  cache = buildPinyinIndex(uniq);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), names: uniq })); } catch { /* ignore */ }
  listeners.forEach((f) => { try { f(); } catch { /* ignore */ } });
  return uniq.length;
}

/** V4.4.5：结果页搜到的片名增量并入索引（搜过一次以后输首字母即可联想）。 */
export function addNamesToSuggestIndex(names: (string | undefined)[]): number {
  const clean = (names || []).map((n) => (n || '').trim()).filter(Boolean) as string[];
  if (!clean.length) return 0;
  if (!cacheNames) loadSuggestIndex();
  return commitNames([...(cacheNames ?? []), ...clean]);
}

/**
 * V4.5.0：拉取云端联想词库（Worker 每日 cron 更新），带 12h 本地缓存 + 超时兜底。
 * 返回词名数组，失败返回空数组（不影响本地预热）。
 */
async function fetchCloudSuggestNames(): Promise<string[]> {
  try {
    try {
      const raw = localStorage.getItem(CLOUD_CACHE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj?.names && Array.isArray(obj.names) && Date.now() - (obj.ts || 0) < CLOUD_TTL) {
          return obj.names.filter((x: any) => typeof x === 'string');
        }
      }
    } catch { /* ignore */ }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 5000);
    let names: string[] = [];
    try {
      const res = await fetch(CLOUD_SUGGEST_URL, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (res.ok) {
        const data: any = await res.json();
        if (data && Array.isArray(data.names)) {
          names = data.names.filter((x: any) => typeof x === 'string' && x.trim());
          try { localStorage.setItem(CLOUD_CACHE_KEY, JSON.stringify({ ts: Date.now(), names })); } catch { /* ignore */ }
        }
      }
    } finally {
      window.clearTimeout(timer);
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * 软件启动时后台预热（V4.4.5 A 方案）：
 *   ① 各源首页片名；
 *   ② 热榜 4 类各 10 部当关键词，跑一轮全站搜索收片名；
 *   ③ 合并去重 → 拼音索引 → 缓存并通知。
 * 并发上限 6，单个源慢/挂不拖垮整体；全部后台异步。
 */
export async function prewarmSuggestIndex(sources: SourceConfig[]): Promise<number> {
  const active = (sources || []).filter((s) => s.enabled);
  const names: string[] = [];
  // V4.5.0：云端词库优先并入（经典片 + 每日更新的新片），FCWR→非诚勿扰 靠它命中。
  // 即使无源也要拉云端词库，保证搜索联想可用。
  let cloud: string[] = [];
  try { cloud = await fetchCloudSuggestNames(); } catch { /* ignore */ }
  if (cloud.length) names.push(...cloud);
  if (!active.length) return commitNames(names);
  try {
    // ① 各源首页片名（limit 60 → 120，覆盖面更广）
    const r = await aggregateHomeCached(active, { timeout: 12000, limit: 120 });
    r.items.forEach((i) => { const t = (i.title || '').trim(); if (t) names.push(t); });
  } catch { /* 首页拉取失败不影响第二步 */ }

  // ② 热榜 4 类各 10 部当关键词，跑一轮全站搜索收片名
  let keywords: string[] = [];
  try {
    const hot = await fetchHot(false);
    if (hot) {
      keywords = [
        ...(hot.categories?.tv ?? []),
        ...(hot.categories?.movie ?? []),
        ...(hot.categories?.variety ?? []),
        ...(hot.categories?.anime ?? []),
      ].map((x) => x.name).filter(Boolean);
    }
  } catch { /* ignore */ }
  keywords = Array.from(new Set(keywords.map((k) => k.trim()).filter(Boolean))).slice(0, 40);

  // 关键词并发跑全站搜索（限并发 6）
  if (keywords.length) {
    const CONC = 6;
    for (let i = 0; i < keywords.length; i += CONC) {
      const batch = keywords.slice(i, i + CONC);
      await Promise.all(batch.map(async (kw) => {
        try {
          const res = await aggregateSearch(active, kw, { timeout: 9000 });
          res.items.forEach((it) => { const t = (it.title || '').trim(); if (t) names.push(t); });
        } catch { /* 单个关键词失败忽略 */ }
      }));
    }
  }

  // ③ 合并已有本地索引 + 本轮新收片名 → 去重入库
  if (!cacheNames) loadSuggestIndex();
  return commitNames([...(cacheNames ?? []), ...names]);
}
