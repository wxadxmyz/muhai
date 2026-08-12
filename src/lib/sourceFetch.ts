// 源配置地址自动抓取与解析：支持 JSON 直链，也支持 HTML 订阅页里的链接提取。
// 用于「导入 json 源 / 导入 json 音源」子页面的「配置地址」自动抓取。

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

export async function fetchFromUrl(input: string): Promise<FetchResult> {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return { kind: 'error', message: `请求失败：HTTP ${res.status}` };
    const text = await res.text();
    const ct = res.headers.get('content-type') || '';
    const trimmed = text.trim();

    if (ct.includes('json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const data = JSON.parse(trimmed);
        const arr = Array.isArray(data) ? data : Array.isArray(data?.sources) ? data.sources : [data];
        const valid = normalize(arr);
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
    const uniq = [...new Set(links)];
    if (uniq.length) return { kind: 'links', links: uniq };
    return { kind: 'error', message: '未在该页面识别到可用的源配置，请改用「本地文件」或手动粘贴。' };
  } catch (e: any) {
    return {
      kind: 'error',
      message: `抓取失败：${e?.message || e}（可能是跨域限制，请复制原始地址或下载后用本地文件导入）`,
    };
  }
}

export function parsePasted(text: string): { sources: any[]; error?: string } {
  const t = text.trim();
  if (!t) return { sources: [], error: '内容为空' };
  try {
    const data = JSON.parse(t);
    const arr = Array.isArray(data) ? data : Array.isArray(data?.sources) ? data.sources : [data];
    const valid = normalize(arr);
    if (valid.length) return { sources: valid };
    return { sources: [], error: '未找到有效源（需包含 type 与 baseUrl）' };
  } catch (e: any) {
    return { sources: [], error: 'JSON 解析失败：' + (e?.message || e) };
  }
}
