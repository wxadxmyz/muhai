// v2.5.9 普通解析源适配器
//
// 处理 TVBox / 苹果CMS 标准点播接口（api.php/provide/vod 风格）：
//   - 不依赖 spider / Java 引擎，直接 HTTP 请求后端 fetchsource 代理
//   - 支持 搜索(ac=search&wd=) / 详情(ac=detail&ids=) / 列表(ac=list) 标准苹果CMS 协议
//   - 映射到幕海 MediaItem / PlayUrl
//
// 与 tvbox 蜘蛛源的区别：tvbox 配置里"站点 api 是标准 http 接口、无 spider"的源，
// 以前被 collectSpiders 的 `continue` 跳过；本适配器让它们可用，从而主页/搜索能出内容。
import { invoke } from '@tauri-apps/api/core';
import { MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';

async function fetchText(url: string): Promise<string> {
  try {
    return await invoke<string>('fetchsource', { url });
  } catch {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}

// 去掉末尾查询串，避免"用户粘贴时带了 ?ac=xxx"导致拼接出 ?ac=list?ac=list
function cleanEndpoint(u: string): string {
  return u.replace(/\/+$/, '').split('?')[0];
}

// 标准苹果CMS 接口请求（GET 拼参数），返回解析后的 JSON
async function apiJson(endpoint: string, params: Record<string, string>): Promise<any> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${endpoint}?${qs}`;
  const text = await fetchText(url);
  try {
    return JSON.parse(text);
  } catch {
    if (text.trimStart().startsWith('<?xml')) {
      throw new Error('该接口返回 XML（TVBox RSS 格式），本版仅支持 JSON 接口');
    }
    throw new Error('接口返回非 JSON：' + text.slice(0, 80));
  }
}

function toItems(list: any[], cfg: SourceConfig): MediaItem[] {
  if (!Array.isArray(list)) return [];
  return list.map((v: any) => ({
    id: String(v.vod_id ?? v.id ?? ''),
    sourceId: cfg.id,
    sourceName: cfg.name,
    title: v.vod_name ?? v.name ?? '未命名',
    artist: v.vod_remarks ?? v.type_name ?? '',
    cover: v.vod_pic ?? v.pic ?? '',
    year: v.vod_year ?? v.year ?? '',
    mediaType: 'video' as const,
    raw: v,
  }));
}

// 选集格式：group1$url1#url2$$$group2$url3#url4
function toEpisodes(playUrl: string): { name: string; url: string }[] {
  if (!playUrl) return [];
  const out: { name: string; url: string }[] = [];
  for (const group of playUrl.split('$$$')) {
    for (const seg of group.split('#')) {
      if (!seg) continue;
      const idx = seg.indexOf('$');
      if (idx < 0) out.push({ name: seg, url: seg });
      else out.push({ name: seg.slice(0, idx), url: seg.slice(idx + 1) });
    }
  }
  return out;
}

// v2.7.0 自解析：CMS 接口返回的播放地址常常是 HTML 分享页（量子/飞极速等），里面
// 内嵌一段 JS：`var main = "/path/index.m3u8?sign=..."` 或同类变量名。
// 通过抓分享页 → 提取 m3u8 → 用 URL 原域拼装成完整链接，回给播放器 HLS。
// 已经直链（#EXTM3U / .mp4）的原样返回。
export async function resolvePlayUrl(url: string): Promise<string> {
  if (!url) return url;
  if (/\.(m3u8|mp4)(\?|$)/i.test(url)) return url; // 看起来已是直链，省一次请求
  try {
    const text = await fetchText(url);
    if (!text) return url;
    const t = text.trimStart();
    if (t.startsWith('#EXTM3U')) return url; // 已经是 m3u8 文本
    // 常见分享页变量名：main / url / m3u8 / play_url / video_url（支持 var / const / let）
    const m =
      text.match(/(?:var|const|let)\s+main\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
      text.match(/(?:var|const|let)\s+(?:url|m3u8|play_url|video_url)\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
      text.match(/src\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i);
    if (m) return new URL(m[1], url).href;
    return url; // 解析不出，原样返回给播放器去尝试
  } catch {
    return url;
  }
}

export function createNormalSource(cfg: SourceConfig): MediaSource {
  const endpoint = cleanEndpoint(cfg.api || cfg.baseUrl);

  return {
    async search(keyword: string) {
      const data = await apiJson(endpoint, { ac: 'search', wd: keyword, pg: '1' });
      return toItems(data?.list ?? [], cfg);
    },

    async getDetail(itemId: string) {
      const data = await apiJson(endpoint, { ac: 'detail', ids: itemId });
      const items = toItems(data?.list ?? [], cfg);
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

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      // 普通解析源的播放地址在详情 vod_play_url 中；取首条线路首集
      const data = await apiJson(endpoint, { ac: 'detail', ids: itemId });
      const v = (data?.list ?? [])[0];
      if (!v?.vod_play_url) return { url: '' };
      const eps = toEpisodes(v.vod_play_url);
      const raw = eps[0]?.url ?? '';
      const url = await resolvePlayUrl(raw);
      return { url, headers: { Referer: endpoint + '/' } };
    },

    async test() {
      try {
        const data = await apiJson(endpoint, { ac: 'list', pg: '1' });
        return Array.isArray(data?.list) && data.list.length > 0;
      } catch {
        return false;
      }
    },

    async home() {
      const data = await apiJson(endpoint, { ac: 'list', pg: '1' });
      return toItems(data?.list ?? [], cfg);
    },
  };
}
