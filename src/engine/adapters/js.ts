import { invoke } from '@tauri-apps/api/core';
import { LiveChannelSource, MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';

// v2.3.8 统一 JS 引擎源适配器（兼容 CatVod / drpy 两种生态）
//
// 执行 spider 脚本驱动任意影视源。脚本经 Rust run_spider 命令在 QuickJS 沙箱内运行，
// 网络请求由 fetch 桥接回 Rust 代理（绕开 CORS 与 Android 明文 HTTP 限制）。
//
// v2.3.8 新增 CatVod 兼容层：
//  1. 脚本预处理：去掉顶层 ESM `export`/`import`（QuickJS script 模式不支持），
//     并注入同步 `req`/`request` 桥（包装引擎的同步 fetch），满足 CatVod "必须同步"约定；
//  2. 返回值二次解析：CatVod 蜘蛛常返回 JSON 字符串，对字符串结果再 JSON.parse 一次；
//  3. 函数命名映射：CatVod 用 `homeContent/searchContent/detailContent/playerContent`，
//     drpy/全局函数用 `home/search/detail/play`。优先调 Content 命名，不可用则回退短名。
//
// play() 的 CatVod flag 链路需详情里携带 vod_play_flag，v2.3.9 规划；当前只调 play。

const CATVOD_REQ_SHIM =
  ";(function(){" +
    "if(typeof globalThis.req!=='function'){" +
      "globalThis.req=function(url,o){" +
        "o=o||{};" +
        "var hd=o.headers?JSON.stringify(o.headers):null;" +
        "return fetch(url,hd,o.body||null);" +
      "};" +
    "}" +
    "if(typeof globalThis.request!=='function'){globalThis.request=globalThis.req;}" +
  "})();\n";

// 预处理脚本：去 ESM 顶层 import/export，前置 req 桥
function catvodize(code: string): string {
  const stripped = code.replace(/^\s*(export|import)\s+.*$/gm, '');
  return CATVOD_REQ_SHIM + stripped;
}

// 跨实例 spider 脚本缓存：同一 URL 的 spider 只下载/执行预处理一次。
// 多子站共享同一 spider（如 drpy2.min.js）时避免重复拉取导致的超时。
const codeCache = new Map<string, string>();
function cachedCatvodize(url: string | undefined, code: string): string {
  if (!url) return catvodize(code);
  const hit = codeCache.get(url);
  if (hit) return hit;
  const out = catvodize(code);
  if (codeCache.size > 64) codeCache.clear(); // 防内存膨胀，最多缓存 64 个脚本
  codeCache.set(url, out);
  return out;
}

// 从预处理后的代码里检测是否声明了对应的 Content 命名函数
function detectCaps(code: string) {
  return {
    homeContent: /\bfunction\s+homeContent\b/.test(code),
    searchContent: /\bfunction\s+searchContent\b/.test(code),
    detailContent: /\bfunction\s+detailContent\b/.test(code),
    playerContent: /\bfunction\s+playerContent\b/.test(code),
  };
}

export function createJsSource(cfg: SourceConfig): MediaSource {
  const jsCfg = cfg as any;
  let cachedCode: string | null = null;
  let caps: { homeContent: boolean; searchContent: boolean; detailContent: boolean; playerContent: boolean } | null = null;

  async function loadCode(): Promise<string> {
    if (cachedCode) return cachedCode;
    let raw: string;
    let cacheKey: string | undefined;
    if (jsCfg.spider) raw = jsCfg.spider;
    else if (jsCfg.spiderUrl) {
      cacheKey = jsCfg.spiderUrl;
      raw = await invoke<string>('fetchsource', { url: jsCfg.spiderUrl });
    } else if (jsCfg.api) {
      cacheKey = jsCfg.api;
      raw = await invoke<string>('fetchsource', { url: jsCfg.api });
    } else throw new Error('JS 源缺少 spider 脚本（需提供 spider / spiderUrl / api 之一）');
    cachedCode = cachedCatvodize(cacheKey, raw);
    caps = detectCaps(cachedCode);
    return cachedCode;
  }

  async function call(func: string, args: string[]): Promise<any> {
    const code = await loadCode();
    const raw = await invoke<string>('run_spider', {
      payload: { code, func, args, api: jsCfg.api, ext: jsCfg.ext },
    });
    // v2.4.2 调试：记录每个 spider 最近一次原始返回，供搜索/首页空白时回显，
    // 无需 root/logcat 即可看到蜘蛛到底返回了什么（接口失败/字段不对/被墙）。
    lastRaw.set(jsCfg.id, raw);
    console.log(`[spider] ${jsCfg.name} ${func} 返回长度=${raw.length}`);
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    // CatVod 蜘蛛常返回 JSON 字符串，需二次解析
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        /* 保留为字符串 */
      }
    }
    return parsed;
  }

  // CatVod 兼容：优先调 Content 命名（若代码声明），结果空或调用失败则回退短名
  async function callCompat(
    primary: 'homeContent' | 'searchContent' | 'detailContent' | 'playerContent',
    fallback: string,
    args: string[],
    usable: (r: any) => boolean,
  ): Promise<any> {
    if (caps && caps[primary]) {
      try {
        const r = await call(primary, args);
        if (usable(r)) return r;
      } catch {
        /* primary 调用失败，回退 */
      }
    }
    try {
      return await call(fallback, args);
    } catch {
      return undefined;
    }
  }

  function toItems(list: any[]): MediaItem[] {
    if (!Array.isArray(list)) return [];
    return list.map((v: any) => ({
      id: String(v.vod_id ?? v.id ?? ''),
      sourceId: cfg.id,
      sourceName: cfg.name,
      title: v.vod_name ?? v.name ?? '未命名',
      artist: v.vod_remarks ?? v.type_name ?? '',
      cover: v.vod_pic ?? v.pic ?? '',
      mediaType: 'video' as const,
      raw: v,
    }));
  }

  // TVBox 选集格式：选集1$url1#选集2$url2
  function toEpisodes(playUrl: string): { name: string; url: string }[] {
    if (!playUrl) return [];
    return playUrl.split('#').map((seg) => {
      const idx = seg.indexOf('$');
      if (idx < 0) return { name: seg, url: seg };
      return { name: seg.slice(0, idx), url: seg.slice(idx + 1) };
    });
  }

  const hasList = (r: any) =>
    !!r && ((Array.isArray(r.list) && r.list.length > 0) || (Array.isArray(r) && r.length > 0));

  return {
    async search(keyword: string) {
      const data = await callCompat('searchContent', 'search', [keyword], hasList);
      const list = data?.list ?? (Array.isArray(data) ? data : []);
      return toItems(list);
    },

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      // CatVod playerContent 可能返回 {url:"..."} 或裸 URL 字符串；play 同理。
      let data: any;
      if (caps?.playerContent) {
        try { data = await call('playerContent', [itemId, itemId]); } catch { /* 回退 */ }
      }
      if (data == null) data = await call('play', [itemId]);
      let url = '';
      if (typeof data === 'string') url = data;
      else if (data && typeof data.url === 'string') url = data.url;
      return { url };
    },

    async getDetail(itemId: string) {
      const data = await callCompat('detailContent', 'detail', [itemId], hasList);
      const list = data?.list ?? (Array.isArray(data) ? data : []);
      const items = toItems(list);
      const it = items[0];
      if (it && it.raw?.vod_play_url) {
        it.episodes = toEpisodes(it.raw.vod_play_url);
      }
      return (
        it ?? {
          id: itemId,
          sourceId: cfg.id,
          sourceName: cfg.name,
          title: '',
          mediaType: 'video' as const,
        }
      );
    },

    async test() {
      try {
        await loadCode();
        return true;
      } catch {
        return false;
      }
    },

    async home() {
      const data = await callCompat('homeContent', 'home', [], hasList);
      const list = data?.list ?? (Array.isArray(data) ? data : []);
      return toItems(list);
    },

    async lives(): Promise<LiveChannelSource[]> {
      try {
        const data = await call('lives', []);
        const arr = Array.isArray(data) ? data : data?.list ?? [];
        return arr.map((l: any) => ({
          name: l.name ?? l.title ?? '直播线路',
          url: l.url,
        })) as LiveChannelSource[];
      } catch {
        return [];
      }
    },
  };
}

// v2.4.2 调试：记录每个 spider 最近一次原始返回（按源 id），供 tvbox.ts 在
// 搜索/首页空白时回显具体返回内容，无需 root 即可定位"蜘蛛跑通但返回空"。
const lastRaw = new Map<string, string>();
export function getSpiderRaw(id: string): string | undefined {
  return lastRaw.get(id);
}