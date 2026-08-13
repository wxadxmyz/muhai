// 源配置地址自动抓取与解析：支持 JSON 直链，也支持 HTML 订阅页里的链接提取。
// 用于「导入 json 源 / 导入 json 音源」子页面的「配置地址」自动抓取。
//
// 方案C：抓取由 Rust 后端命令 fetchsource 代理完成，彻底绕开 WebView 前端
// 的 CORS 与 Android 明文 HTTP 限制（可导入 http://饭太硬.cc/tv 这类地址）。
// 若不在 Tauri 环境（本地 web 调试）则回退到前端 fetch。

import { invoke } from '@tauri-apps/api/core';

export type FetchResult =
  | { kind: 'sources'; sources: any[] }
  | { kind: 'links'; links: string[] }
  | { kind: 'error'; message: string };

function toAbsolute(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function looksLikeSourceLink(href: string): boolean {
  const h = href.toLowerCase();
  if (h.startsWith('javascript:') || h.startsWith('#') || h.startsWith('mailto:')) return false;
  return /\.json($|\?)/.test(h) || /(json|config|drpy|tvbox|cat|api|txt|m3u|web|share|resource)/.test(h);
}

function normalize(arr: any[]): any[] {
  return arr
    .filter((r) => r && typeof r === 'object')
    .map((r) => {
      const o = { ...r };
      // 部分订阅源用 api 字段代替 baseUrl
      if (!o.baseUrl && o.api) o.baseUrl = o.api;
      return o;
    })
    .filter((r) => r.type && r.baseUrl);
}

// 兼容常见的 tvbox / 苹果CMS / 聚合源 JSON 结构，统一转成带 type+baseUrl 的源数组：
//  1) 顶层数组
//  2) {sources:[...]}
//  3) {urls:[...]}（tvbox 标准订阅格式，单项含 url/api/name）
//  4) {sites:[...]}（部分聚合站格式）
//  5) 单个源对象
// tvbox 项的 type 若为数字分类（1/2/3/4）则视为影视站(video-cms)；字符串 type 保留原值。
function toSourceList(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.sources)) return data.sources;
  if (Array.isArray(data?.urls)) {
    return data.urls.map((u: any) => ({
      ...u,
      baseUrl: u.baseUrl || u.url || u.api,
      type: u.type && typeof u.type === 'string' ? u.type : 'video-cms',
    }));
  }
  if (Array.isArray(data?.sites)) {
    return data.sites.map((s: any) => ({
      ...s,
      baseUrl: s.baseUrl || s.url || s.api,
      type: s.type && typeof s.type === 'string' ? s.type : 'video-cms',
    }));
  }
  return [data];
}

// 优先走 Rust 后端代理抓取；不在 Tauri 环境时回退前端 fetch。
async function fetchText(url: string): Promise<string> {
  try {
    return await invoke<string>('fetchsource', { url });
  } catch {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}

function parseFetched(text: string, url: string): FetchResult {
  const trimmed = text.trim();

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      const valid = normalize(toSourceList(data));
      if (valid.length) return { kind: 'sources', sources: valid };
    } catch {
      /* 不是 JSON，往下走 HTML 分支 */
    }
  }

  // HTML：提取页面里的订阅/配置链接
  const links: string[] = [];
  const re = /href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const href = m[1];
    if (looksLikeSourceLink(href)) links.push(toAbsolute(href, url));
  }
  // 新增：导航页常用 data-clipboard-text / data-url 等“点击复制”属性存真实源地址，
  // 宽松收录 http 链接（饭太硬这类 tvbox 仓库入口全靠它）
  const attrRe = /(?:data-clipboard-text|data-url|data-href|clipboardText|data-source)=["']([^"']+)["']/gi;
  let a2: RegExpExecArray | null;
  while ((a2 = attrRe.exec(text))) {
    const href = a2[1].trim();
    if (
      href &&
      /^https?:\/\//i.test(href) &&
      !/\.(css|js|png|jpe?g|svg|gif|ico|font)(\?|#|$)/i.test(href)
    ) {
      links.push(toAbsolute(href, url));
    }
  }
  const uniq = [...new Set(links)];
  if (uniq.length) return { kind: 'links', links: uniq };
  return { kind: 'error', message: '未在该页面识别到可用的源配置，请改用「本地文件」或手动粘贴。' };
}

export async function fetchFromUrl(input: string): Promise<FetchResult> {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  try {
    const text = await fetchText(url);
    return parseFetched(text, url);
  } catch (e: any) {
    return {
      kind: 'error',
      message: `抓取失败：${e?.message || e}`,
    };
  }
}

export function parsePasted(text: string): { sources: any[]; error?: string } {
  const t = text.trim();
  if (!t) return { sources: [], error: '内容为空' };
  try {
    const data = JSON.parse(t);
    const valid = normalize(toSourceList(data));
    if (valid.length) return { sources: valid };
    return { sources: [], error: '未找到有效源（需包含 type 与 baseUrl）' };
  } catch (e: any) {
    return { sources: [], error: 'JSON 解析失败：' + (e?.message || e) };
  }
}
