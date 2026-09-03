// A12：首页「豆瓣热门」数据层 —— 从订阅仓库拉取 hot.json，本地缓存 + 静默刷新。
//   hot.json 由仓库脚本（scripts/gen_hot.py 豆瓣版 / 手工策展）生成，每天刷新 Banner、15 天刷新四板块。
//   这里只负责「拉 + 缓存」，渲染在 Home.tsx。拉取失败不影响原聚合首页（Home.tsx 兜底仍显示源站内容）。

export interface HotItem {
  id: string;
  name: string;
  type?: string; // tv / movie / variety / anime
  year?: string;
  rating?: number;
  area?: string; // 内地 / 港澳 / 海外 …
  pic?: string; // 海报；空字符串时前端用渐变占位块
  desc?: string; // Banner 简介
}

export interface HotData {
  updated: string;
  refresh?: { banner?: string; categories?: string };
  note?: string;
  banner: HotItem[];
  categories: {
    tv: HotItem[];
    movie: HotItem[];
    variety: HotItem[];
    anime: HotItem[];
  };
}

// 首页热门数据源：优先走 Cloudflare Worker（自有域名 wu2000.top，边缘节点稳定可达，
// 且由 cron 每天定时重新爬取豆瓣，数据自动更新）。
// 备链为 gitee raw（Worker 不可用时兜底）。两者均可在设置里改 hotUrl 覆盖。
export const DEFAULT_HOT_URL = 'https://wu2000.top/hot.json';
export const FALLBACK_HOT_URL = 'https://gitee.com/xmyzjxn/muhai-vod/raw/master/hot.json';

const CACHE_KEY = 'muhai_hot_cache';
const TTL = 12 * 60 * 60 * 1000; // 12h：本地缓存有效期，期间不重复联网；过期后启动静默刷新

function cacheRead(): HotData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj?.data && Date.now() - obj.ts < TTL) return obj.data as HotData;
  } catch {
    /* ignore */
  }
  return null;
}
function cacheWrite(data: HotData) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    /* ignore */
  }
}

/** 拉取首页推荐数据。force=true 跳过本地缓存直接联网。失败返回 null（调用方兜底用聚合首页）。 */
export async function fetchHot(force = false, url = DEFAULT_HOT_URL): Promise<HotData | null> {
  if (!force) {
    const cached = cacheRead();
    if (cached) return cached;
  }
  try {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    window.clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = (await res.json()) as HotData;
    if (!data || !data.categories) return null;
    cacheWrite(data);
    return data;
  } catch {
    // 主链（Cloudflare）失败 → 试备链（gitee raw）
    if (url === DEFAULT_HOT_URL) return fetchHot(force, FALLBACK_HOT_URL);
    // 都失败 → 回退到任何已有缓存
    return cacheRead();
  }
}
