// ============================================================================
// 弹幕抓取模块（幕海 v4.5.8 · 稳妥版）
// 放置路径：src/engine/danmaku.ts
//
// 作用：按影片片名搜索 B 站视频，取回对应的弹幕 XML，解析成 string[]，
//       供播放器渲染层（detail.danmaku）直接飘屏。
//
// 数据来源链路：
//   片名 → api.bilibili.com/x/web-interface/search/type 拿 bvid
//        → api.bilibili.com/x/web-interface/view 拿 cid
//        → comment.bilibili.com/{cid}.xml 拿弹幕（<d>...</d> 节点）
//
// V4.5.8 稳妥版改动：所有请求优先走 Rust 后端代理 invoke('fetchmedia', {url, headers})，
// 绕开 Android WebView 的 CORS 与自定义头限制（B站搜索必须带 Referer + Cookie，
// 裸 fetch 在 WebView 里既跨域又无法可靠带自定义头）。非 Tauri 环境（开发/测试）降级原生 fetch。
// ============================================================================

import { invoke } from '@tauri-apps/api/core';

/** 弹幕源配置（从 all-sources.json 的特殊条目解析而来） */
export interface DanmakuConfig {
  /** 是否启用全局自动弹幕 */
  enabled: boolean;
  /** 弹幕接口提供方：当前支持 'bilibili'，预留扩展 */
  provider: 'bilibili';
  /** 每条影片最多取多少条弹幕（B站 XML 通常 1000 条上限），默认 300 */
  maxCount?: number;
  /** 搜索结果标题与片名的最低相似度阈值 0~1，低于则跳过，默认 0.3 */
  minSimilarity?: number;
  /** 弹幕缓存时长（小时），默认 24 */
  cacheHours?: number;
}

const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------- 配置读写（由 all-sources.json 顶层 danmaku 字段写入） ----------
const DM_KEY = 'mps_danmaku_config';

export function setDanmakuConfig(cfg: DanmakuConfig) {
  try {
    localStorage.setItem(DM_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

export function getDanmakuConfig(): DanmakuConfig | null {
  try {
    const raw = localStorage.getItem(DM_KEY);
    return raw ? (JSON.parse(raw) as DanmakuConfig) : null;
  } catch {
    return null;
  }
}

/** 生成一个随机 buvid3（B站搜索接口风控需要带 cookie，否则 412） */
function randomBuvid(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s + 'infoc';
}

/** 简单标题清洗：去 HTML 标签、去集数/花絮后缀噪音，用于相似度比较 */
function cleanTitle(t: string): string {
  return String(t || '')
    .replace(/<[^>]*>/g, '')
    .replace(/【[^】]*】|\[[^\]]*\]/g, '')
    .replace(/(第?\d+集?|全集|正片|预告|花絮|解说|混剪|影视|电视剧|动漫|完整版)/g, '')
    .replace(/[\s\-—_:：·,.，。!！?？]/g, '')
    .toLowerCase()
    .trim();
}

/** 计算两个字符串的简单包含相似度（0~1） */
function similarity(a: string, b: string): number {
  const x = cleanTitle(a);
  const y = cleanTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length > y.length ? x : y;
  if (longer.includes(shorter)) return shorter.length / longer.length;
  // 逐字命中率兜底
  let hit = 0;
  for (const ch of shorter) if (longer.includes(ch)) hit++;
  return hit / Math.max(shorter.length, longer.length);
}

// ---------- 内存缓存（避免同一片名反复请求触发 B站风控） ----------
const dmCache = new Map<string, { ts: number; items: string[] }>();

function cacheGet(key: string, hours: number): string[] | null {
  const v = dmCache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > hours * 3600 * 1000) {
    dmCache.delete(key);
    return null;
  }
  return v.items;
}
function cacheSet(key: string, items: string[], hours: number) {
  dmCache.set(key, { ts: Date.now(), items });
}

/** 把后端 fetchmedia 返回的 base64（{data,url} JSON 或纯字符串）解成 UTF-8 文本 */
function decodeFetchmediaResult(r: unknown): string {
  let b64 = '';
  if (typeof r === 'string') {
    const s = r.trim();
    if (s.startsWith('{')) {
      try { b64 = String((JSON.parse(s) as any)?.data ?? ''); } catch { return ''; }
    } else {
      b64 = s;
    }
  } else {
    b64 = String((r as any)?.data ?? '');
  }
  if (!b64) return '';
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

/**
 * 带超时的文本请求（稳妥版：优先后端 fetchmedia 代理绕开 WebView CORS + 支持自定义头，
 * 非 Tauri 环境降级原生 fetch）。
 */
async function fetchText(url: string, headers: Record<string, string>, timeout = 12000): Promise<string> {
  // V4.5.10 #弹幕：优先走后端专用 fetchtext——它禁用 reqwest 自动解压、手动解 B站 raw deflate。
  // （旧 fetchmedia 走 reqwest ZlibDecoder 解不开 raw deflate，弹幕一直为空）
  try {
    const text = await Promise.race([
      invoke<string>('fetchtext', { url, headers }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('proxy timeout')), timeout)),
    ]);
    if (text) return text;
  } catch {
    /* fetchtext 不可用（旧版后端）→ 继续降级 */
  }
  // 兜底：旧版 fetchmedia 代理（真机 WebView 裸 fetch 会踩跨域，且 B站需自定义头）
  try {
    const r = await Promise.race([
      invoke<unknown>('fetchmedia', { url, headers, body: null }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('proxy timeout')), timeout)),
    ]);
    const text = decodeFetchmediaResult(r);
    if (text) return text;
  } catch {
    /* 代理失败 → 降级原生 fetch（开发/浏览器环境） */
  }
  // 降级：原生 fetch（仅非 Tauri / 代理不可用时走到）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 按片名抓取 B 站弹幕。
 * @param title 影片片名
 * @param cfg 弹幕配置
 * @returns 弹幕文本数组；失败返回空数组（静默降级，不影响播放）
 */
export async function fetchDanmaku(title: string, cfg: DanmakuConfig): Promise<string[]> {
  if (!cfg?.enabled || !title) return [];
  const maxCount = cfg.maxCount ?? 300;
  const minSim = cfg.minSimilarity ?? 0.3;
  const cacheHours = cfg.cacheHours ?? 24;

  const cached = cacheGet(title, cacheHours);
  if (cached) return cached;

  try {
    // 1) 搜索视频（B站风控：需 Referer + buvid3 cookie）
    const kw = encodeURIComponent(title);
    const searchUrl =
      `https://api.bilibili.com/x/web-interface/search/type` +
      `?search_type=video&keyword=${kw}&page=1`;
    const searchHeaders: Record<string, string> = {
      'User-Agent': BILI_UA,
      Referer: 'https://search.bilibili.com/',
      Cookie: `buvid3=${randomBuvid()}`,
    };
    const searchText = await fetchText(searchUrl, searchHeaders);
    if (!searchText) return [];
    const searchJson = JSON.parse(searchText);
    const results: any[] = searchJson?.data?.result ?? [];
    if (!results.length) return [];

    // 2) 选标题最相似的视频（避免搜到解说/混剪）
    let best: any = null;
    let bestScore = 0;
    for (const r of results) {
      const score = similarity(title, r.title ?? '');
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (!best || bestScore < minSim) return [];

    // 3) 拿 cid（搜索结果里通常不直接给，用 bvid 换）
    const bvid = best.bvid;
    if (!bvid) return [];
    const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    const viewText = await fetchText(viewUrl, {
      'User-Agent': BILI_UA,
      Referer: 'https://www.bilibili.com/',
      Cookie: `buvid3=${randomBuvid()}`,
    });
    if (!viewText) return [];
    const viewJson = JSON.parse(viewText);
    const cid = viewJson?.data?.cid;
    if (!cid) return [];

    // 4) 取弹幕 XML
    const xmlUrl = `https://comment.bilibili.com/${cid}.xml`;
    const xml = await fetchText(xmlUrl, { 'User-Agent': BILI_UA });
    if (!xml) return [];
    // 解析 <d p="...">弹幕文本</d>，反转义 HTML 实体
    const matches = xml.match(/<d\s+p="[^"]*">([^<]*)<\/d>/g) ?? [];
    const items = matches
      .map((m) => {
        const inner = m.replace(/^<d\s+p="[^"]*">/, '').replace(/<\/d>$/, '');
        return inner
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim();
      })
      .filter(Boolean)
      .slice(0, maxCount);

    if (items.length) cacheSet(title, items, cacheHours);
    return items;
  } catch {
    // 网络失败 / 风控 / 解析失败：静默降级，绝不影响播放
    return [];
  }
}
