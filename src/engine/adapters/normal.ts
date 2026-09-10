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

// 详情字段兼容：不同站点返回的字段名千奇百怪（vod_pic/pic、vod_content/vod_blurb、
// vod_class/vod_tag、vod_score/vod_douban_score…），这里统一映射 + 空值兜底，
// 保证详情页不会因为某个字段缺失而整片空白（V3.3.2 #3 修复点）。
function toDetail(raw: any, cfg: SourceConfig): MediaItem {
  const cover =
    raw?.vod_pic || raw?.vod_pic_slide?.split?.('$$$')?.[0] || raw?.pic || '';
  const desc =
    raw?.vod_content || raw?.vod_blurb || raw?.vod_remarks || '';
  const genre = raw?.vod_class || raw?.vod_tag || '';
  const year = raw?.vod_year || raw?.vod_pubdate || '';
  const score = raw?.vod_score || raw?.vod_douban_score || '';
  const episodes = raw?.vod_play_url ? toEpisodes(raw.vod_play_url) : [];
  return {
    id: String(raw?.vod_id ?? raw?.id ?? ''),
    sourceId: cfg.id,
    sourceName: cfg.name,
    title: raw?.vod_name ?? raw?.name ?? '未命名',
    artist: raw?.vod_remarks ?? raw?.type_name ?? '',
    cover,
    year,
    genre,
    score,
    mediaType: 'video' as const,
    episodes,
    desc,
    raw,
  };
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
      text.match(/src\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
      // V3.3.1 Q3：更宽的兜底——不管变量名叫什么，页面里只要出现引号包裹的 m3u8 路径就取它。
      // 各家分享页模板的赋值名千奇百怪（已见过 main / playurl / data-url / 直接写在
      // player 配置对象里），按名匹配漏一个就等于整条线路播不了。
      text.match(/["']([^"'\s]*\.m3u8[^"'\s]*)["']/i);
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
      const list = data?.list ?? [];
      const it = list[0] ? toDetail(list[0], cfg) : null;
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
      // 普通解析源的播放地址在详情 vod_play_url 中；vod_play_url 形如
      //  线路1$url1#url2#url3$$$线路2$url4#url5#url6
      // 不同线路/集数的真实可播地址可能不同（有的要解析 share 页、有的直链）。
      // 轮询所有集直到某条能 resolve 出有效 m3u8/直链——避免"首条线路死了整源都播不了"
      // （V3.3.2 #3 修复点：百度源首集死链导致整源「解码失败」）。
      const data = await apiJson(endpoint, { ac: 'detail', ids: itemId });
      const v = (data?.list ?? [])[0];
      if (!v?.vod_play_url) return { url: '' };
      const eps = toEpisodes(v.vod_play_url);
      for (const ep of eps) {
        try {
          const url = await resolvePlayUrl(ep.url);
          if (url) return { url, headers: { Referer: endpoint + '/' } };
        } catch {
          /* 这条解不出，试下一条 */
        }
      }
      // 全部失败：退回首集原始地址，交给播放器兜底报错（至少能显示"地址解析失败"而非黑屏）
      const raw = eps[0]?.url ?? '';
      return { url: await resolvePlayUrl(raw), headers: { Referer: endpoint + '/' } };
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
