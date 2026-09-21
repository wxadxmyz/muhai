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

// 问题 #10 修复（导入侧）：TVBox 配置普遍是带 // 注释、/* */ 块注释、字符串内裸换行
// 的 JS 风格文本，标准 JSON.parse 直接抛错，导致导入时提示"未识别到可用源配置"。
// 这里复用与 tvbox.ts 一致的清洗逻辑。
function stripJsonComments(text: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/^[ \t]*\/\/.*$/gm, '') // 整行 // 注释
    .replace(/(^|[^:])(\/\/.*$)/gm, '$1') // 行内 // 注释（不误伤 http://）
    .replace(/,(\s*[}\]])/g, '$1') // 尾随逗号容错
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // 其他非转义控制字符
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
  return !!(data && (Array.isArray(data.sites) || Array.isArray(data.urls) || Array.isArray(data.lives)));
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

// V3.6.1：TVBox 配置常把「蜘蛛源」拍平在 sites[] 里。幕海是 Tauri + QuickJS 纯 JS 引擎，
// 跑不了 csp_* Dex 蜘蛛（那是编译成 Java 原生代码的蜘蛛），但能跑 drpy 规则源
//（var rule = {...} / export default {meta,rule}），由 Rust 侧 drpy3 引擎承载。
// 这里把 sites 展开成独立源：drpy 站点 → type:'js'（用规则 URL 当 spiderUrl，框架由引擎自带、忽略 api）；
// csp_* 站点 → 跳过（确定跑不了）；普通 tvbox 站点不在此展开，交由下方 isTvboxConfig 回退「整体单源」保持兼容。
function isJsRuleUrl(u: any): boolean {
  return typeof u === 'string' && /\.js(\?|#|$)/i.test(u);
}

function expandSites(data: any): any[] {
  const sites = Array.isArray(data?.sites) ? data.sites : [];
  const out: any[] = [];
  for (const s of sites) {
    if (!s || typeof s !== 'object') continue;
    const key = s.key || s.id;
    const name = s.name || key || '未命名';
    const api = s.api || '';
    const ext = s.ext || '';
    const spider = s.spider || '';
    const spiderUrl = s.spiderUrl || '';

    // csp_* Dex 蜘蛛：幕海跑不了，跳过
    if (typeof api === 'string' && api.startsWith('csp_')) continue;

    // drpy 规则源判定：内联规则 / 远程 .js 规则 / api 是框架且 ext 是 .js 规则
    const ruleUrl =
      (typeof ext === 'string' && isJsRuleUrl(ext)) ? ext :
      (typeof spiderUrl === 'string' && isJsRuleUrl(spiderUrl)) ? spiderUrl : '';
    const hasInlineRule = typeof spider === 'string' && spider.trim().length > 0 && !isJsRuleUrl(spider);

    if (hasInlineRule || ruleUrl) {
      out.push({
        name,
        type: 'js',
        key,
        spider: hasInlineRule ? spider : undefined,
        spiderUrl: ruleUrl || undefined,
        // ext 透传给 drpy3 适配器做 Referer/host 线索；规则 URL 时也一并带上
        ext: ruleUrl || (typeof ext === 'string' ? ext : undefined),
        baseUrl: ruleUrl || api || '', // 占位：供 importSources 的 type+baseUrl 过滤与 name+baseUrl 去重
        searchable: s.searchable,
        quickSearch: s.quickSearch,
      });
    }
    // 普通 tvbox / 苹果CMS 站点不在此展开，回退「整体单源」处理，保持兼容现有 tvbox 聚合
  }
  return out;
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
      const data = JSON.parse(stripJsonComments(trimmed));
      // 影视仓 / TVBox 聚合配置
      if (isTvboxConfig(data)) {
        // V3.6.1：优先展开其中的 drpy 规则源为独立 type:'js' 源（csp_* Dex 蜘蛛自动跳过）。
        // 这样粘贴聚合地址即可直接得到可跑的 drpy 子站，而不是把整份当单一 tvbox 源吞掉。
        const expanded = expandSites(data);
        if (expanded.length) {
          return { kind: 'sources', sources: expanded };
        }
        // 无 drpy 站点的纯 tvbox 聚合：整体作为「一个」tvbox 源，保持兼容旧行为
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
    const data = JSON.parse(stripJsonComments(t));
    // V3.6.1：含 sites 的 TVBox 配置优先展开其中的 drpy 规则源为独立源
    if (Array.isArray(data?.sites)) {
      const expanded = expandSites(data);
      if (expanded.length) return { sources: expanded };
    }
    const valid = normalize(toSourceList(data));
    if (valid.length) return { sources: valid };
    return { sources: [], error: '未找到有效源（需包含 type 与 baseUrl）' };
  } catch (e: any) {
    return { sources: [], error: 'JSON 解析失败：' + (e?.message || e) };
  }
}
