// tvbox / 影视仓聚合源适配器：粘贴一个配置地址（如 http://www.饭太硬.cc/tv），
// 整体作为一个「源」存储，搜索/播放时再抓取配置、解码 base64、遍历 sites[] 做多协议搜索。
//
// 影视仓生态里大量站点是苹果CMS 后端，本适配器按苹果CMS 风格
//   GET {api}?ac=list&wd={kw}&pg=1  → 取 list[]  → 解析 vod_play_url 得到 m3u8/mp4
// 对纯 CatVod/DRPy「爬虫式」站点（需 spider 二进制）无法直接播放，会给出提示。
//
// 抓取统一走 Rust 后端 fetchsource 代理，绕开 Android WebView 的 CORS 与明文 HTTP 限制。
import { invoke } from '@tauri-apps/api/core';
import { Episode, LiveChannelSource, MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';

function apiBase(u: string): string {
  return (u || '').split('?')[0].replace(/\/+$/, '');
}

// 影视源多线路以 $$$ 分隔；每条线路内部以 # 分隔，单集以 $ 分割 线路$url
function parsePlayGroups(vodPlayUrl: string): Episode[][] {
  if (!vodPlayUrl) return [];
  const parse = (s: string): Episode[] =>
    s
      .split('#')
      .map((seg) => {
        const i = seg.indexOf('$');
        return i === -1 ? null : { name: seg.slice(0, i), url: seg.slice(i + 1) };
      })
      .filter((x): x is Episode => !!x && !!x.url);
  if (vodPlayUrl.includes('$$$')) {
    return vodPlayUrl.split('$$$').map(parse).filter((g) => g.length > 0);
  }
  const g = parse(vodPlayUrl);
  return g.length ? [g] : [];
}

async function fetchText(url: string): Promise<string> {
  try {
    return await invoke<string>('fetchsource', { url });
  } catch {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}

async function fetchJson(url: string): Promise<any> {
  const t = await fetchText(url);
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

// 兼容不同影视源返回结构：{list} / {data:{list}} / {data:[...]} / {rss:{list}}
function normalizeList(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.data?.list)) return data.data.list;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.rss?.list)) return data.rss.list;
  if (Array.isArray(data.rss)) return data.rss;
  return [];
}

// 影视仓部分「加密接口」直接返回 base64 密文，先尝试解码
function tryB64(text: string): string {
  const s = text.trim();
  if (s.length < 16 || s.length % 4 !== 0) return text;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(s)) return text;
  try {
    const d = atob(s.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/')));
    if (d.startsWith('{') || d.startsWith('[')) return d;
  } catch {
    /* 不是合法 base64 */
  }
  return text;
}

export function createTvboxSource(cfg: SourceConfig): MediaSource {
  const base = cfg.baseUrl;
  // itemId -> 站点 api + vodId，供 getPlayUrl 复用（实例级缓存）
  const playCache = new Map<string, { api: string; vodId: string }>();

  async function loadConfig(): Promise<any> {
    const decoded = tryB64(await fetchText(base));
    const json = decoded.startsWith('{') || decoded.startsWith('[') ? decoded : await fetchText(base);
    return JSON.parse(json);
  }

  function resolveSites(data: any): any[] {
    if (Array.isArray(data?.sites)) return data.sites;
    if (Array.isArray(data?.urls)) return data.urls;
    return [];
  }

  function siteToItems(site: any, list: any[]): MediaItem[] {
    const api = apiBase(site.api || site.url || site.baseUrl || '');
    return list.map((it: any) => {
      const groups = parsePlayGroups(it.vod_play_url ?? it.play_url ?? '');
      const eps = groups[0] ?? [];
      const id = `${site.key || site.name || api}__${it.vod_id ?? it.id}`;
      if (api) playCache.set(id, { api, vodId: String(it.vod_id ?? it.id) });
      return {
        id,
        sourceId: cfg.id,
        sourceName: cfg.name,
        title: it.vod_name ?? it.name ?? '未知',
        cover: it.vod_pic ?? it.pic,
        year: it.vod_year,
        mediaType: 'video' as const,
        playUrl: eps[0]?.url,
        episodes: eps,
        raw: { ...it, siteApi: api, vodId: String(it.vod_id ?? it.id) },
      } as MediaItem;
    });
  }

  async function searchSite(site: any, kw: string): Promise<{ items: MediaItem[]; error?: string }> {
    const api = apiBase(site.api || site.url || site.baseUrl || '');
    const name = site.name || site.key || api || '未知站点';
    if (!api) return { items: [], error: `${name}：无 api 地址` };
    const q = encodeURIComponent(kw);
    let lastErr = '';
    for (const seg of ['?ac=list&wd=', '?ac=videolist&wd=']) {
      try {
        const data = await fetchJson(`${api}${seg}${q}&pg=1`);
        const list = normalizeList(data);
        if (Array.isArray(list) && list.length) {
          return { items: siteToItems(site, list) };
        }
        lastErr = `${name}：返回空列表`;
      } catch (e: any) {
        lastErr = `${name}：${(e?.message || String(e)).slice(0, 120)}`;
      }
    }
    return { items: [], error: lastErr || `${name}：未知错误` };
  }

  return {
    async search(keyword: string, _page = 1): Promise<MediaItem[]> {
      const data = await loadConfig();
      const sites = Array.isArray(data?.sites)
        ? data.sites
        : Array.isArray(data?.urls)
          ? data.urls
          : [];
      if (!sites.length) throw new Error('配置中未识别到可用站点');
      const out: MediaItem[] = [];
      const failures: string[] = [];
      const limited = sites.slice(0, 12);
      await Promise.all(
        limited.map(async (site: any) => {
          const r = await searchSite(site, keyword);
          if (r.items.length) out.push(...r.items);
          else if (r.error) failures.push(r.error);
        }),
      );
      if (!out.length) {
        const detail = failures.length ? failures.join('；') : '所有站点均无结果';
        throw new Error(`搜索失败：${detail}`);
      }
      return out;
    },

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      const c = playCache.get(itemId);
      if (!c) return { url: '' };
      try {
        const data = await fetchJson(`${c.api}?ac=detail&ids=${encodeURIComponent(c.vodId)}`);
        const it = normalizeList(data)[0];
        const eps = parsePlayGroups(it?.vod_play_url ?? it?.play_url ?? '');
        return { url: eps[0]?.[0]?.url ?? '' };
      } catch {
        return { url: '' };
      }
    },

    async test(): Promise<boolean> {
      try {
        const data = await loadConfig();
        return Array.isArray(data?.sites) || Array.isArray(data?.urls);
      } catch {
        return false;
      }
    },

    // 首页推荐：各站点最新列表合并（有源主页"站点推荐"用）
    async home(): Promise<MediaItem[]> {
      try {
        const data = await loadConfig();
        const sites = resolveSites(data);
        const out: MediaItem[] = [];
        const limited = sites.slice(0, 6);
        await Promise.all(
          limited.map(async (site: any) => {
            const api = apiBase(site.api || site.url || site.baseUrl || '');
            if (!api) return;
            try {
              const d = await fetchJson(`${api}?ac=list&pg=1`);
              const list = normalizeList(d).slice(0, 8);
              if (Array.isArray(list) && list.length) out.push(...siteToItems(site, list));
            } catch {
              /* 忽略单个站点失败 */
            }
          })
        );
        return out;
      } catch {
        return [];
      }
    },

    // 直播源：返回配置中的 lives[]
    async lives(): Promise<LiveChannelSource[]> {
      try {
        const data = await loadConfig();
        return Array.isArray(data?.lives) ? data.lives : [];
      } catch {
        return [];
      }
    },
  };
}
