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
// tvbox 项的 type 若为数字分类（1/2/3/4）则视为影视站，统一走 tvbox 适配器；字符串 type 保留原值。
function toSourceList(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.sources)) return data.sources;
  if (Array.isArray(data?.urls)) {
    return data.urls.map((u: any) => ({
      ...u,
      baseUrl: u.baseUrl || u.url || u.api,
      type: u.type && typeof u.type === 'string' ? u.type : 'tvbox',
    }));
  }
  if (Array.isArray(data?.sites)) {
    return data.sites.map((s: any) => ({
      ...s,
      baseUrl: s.baseUrl || s.url || s.api,
      type: s.type && typeof s.type === 'string' ? s.type : 'tvbox',
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

// 影视仓 / TVBox 部分「加密接口」（如 http://www.饭太硬.cc/tv 这类）直接返回 base64 密文，
// 这里先尝试解码；解码后通常是带 sites[] 的 TVBox JSON，再递归交给下面的 JSON/HTML 分支处理。
function isTvboxConfig(data: any): boolean {
  return !!(data && (Array.isArray(data.sites) || Array.isArray(data.urls)));
}

function nameFromUrl(u: string): string {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\./, '');
    // jsDelivr / GitHub(raw) 等 CDN：用路径里的仓库名或文件名当名字，
    // 避免导入后显示成裸域名（如 cdn.jsdelivr.net）。
    if (/(^|\.)jsdelivr\.net$/.test(h) || /(^|\.)githubusercontent\.com$/.test(h) || /(^|\.)github\.com$/.test(h)) {
      const parts = url.pathname.split('/').filter(Boolean);
      const last = parts[parts.length - 1] || '';
      const file = last.replace(/\.[^./?]+$/, ''); // 去掉扩展名
      if (file && file !== 'main' && file !== 'master') return decodeURIComponent(file);
      if (parts.length >= 2) return decodeURIComponent(parts[1]); // 仓库名
    }
    if (h) return h;
  } catch {
    /* ignore */
  }
  return '影视仓聚合';
}

function tryDecodeBase64(text: string): string {
  const t = text.trim();
  if (t.length < 16) return text;
  if (t.length % 4 !== 0) return text;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(t)) return text;
  try {
    const b64 = t.replace(/_/g, '/').replace(/-/g, '+');
    const decoded = atob(b64);
    // 解码结果须含可打印字符，避免把普通文本误判为 base64
    if (decoded.length > 0 && decoded.slice(0, 200).match(/[ -~]/)) return decoded;
  } catch {
    /* 不是合法 base64，原样返回 */
  }
  return text;
}

function parseFetched(text: string, url: string): FetchResult {
  const trimmed = text.trim();

  // 先尝试 base64 解码（加密接口返回密文的情形）
  const decoded = tryDecodeBase64(trimmed);
  if (decoded !== trimmed) return parseFetched(decoded, url);

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      // 影视仓 / TVBox 聚合配置：整体作为「一个」tvbox 源，仓库里只显示你粘贴的这个地址
      if (isTvboxConfig(data)) {
        // 优先用配置自身的可读名称（如 name 字段），域名仅作兜底，避免显示成 cdn.jsdelivr.net
        const cfgName =
          typeof data.name === 'string' && data.name.trim() ? data.name.trim() : nameFromUrl(url);
        return {
          kind: 'sources',
          sources: [{ name: cfgName, type: 'tvbox', baseUrl: url }],
        };
      }
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
