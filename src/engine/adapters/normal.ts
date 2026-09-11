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
  return list.map((v: any) => {
    // V3.3.4 #1：搜索结果自带的播放列表直接解析——LZ 等源 ac=search 返回的条目就带完整
    // vod_play_url（实测《仙逆》157 集直链）。旧版把这份数据扔了（只存 raw），点开后选集
    // 必须等第二次 ac=detail 请求补齐，请求一抖选集就空、简介也丢。现在点开即有全部选集。
    const { lineGroups, lineNames } = toLineGroups(v);
    return {
      id: String(v.vod_id ?? v.id ?? ''),
      sourceId: cfg.id,
      sourceName: cfg.name,
      title: v.vod_name ?? v.name ?? '未命名',
      artist: v.vod_remarks ?? v.type_name ?? '',
      cover: v.vod_pic ?? v.pic ?? '',
      year: v.vod_year ?? v.year ?? '',
      mediaType: 'video' as const,
      episodes: lineGroups[0] ?? [],
      raw: { ...v, lineGroups, lineNames },
    };
  });
}

// V3.3.4 #5：LZ 等源的 vod_content 是 HTML（<p>…</p>、&nbsp;），旧版原样存进 desc，
// 播放页"介绍"直接显示源码。剥标签 + 解码常见实体后再存。
function stripHtml(s: unknown): string {
  const str = String(s ?? '');
  if (!str) return '';
  return str
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 详情字段兼容：不同站点返回的字段名千奇百怪（vod_pic/pic、vod_content/vod_blurb、
// vod_class/vod_tag、vod_score/vod_douban_score…），这里统一映射 + 空值兜底，
// 保证详情页不会因为某个字段缺失而整片空白（V3.3.2 #3 修复点）。
function toDetail(raw: any, cfg: SourceConfig): MediaItem {
  const cover =
    raw?.vod_pic || raw?.vod_pic_slide?.split?.('$$$')?.[0] || raw?.pic || '';
  // V3.3.3：简介/年份/类型/评分/播放地址 兼容更多苹果CMS变体字段名（LZ等站点字段命名不统一）。
  const desc = stripHtml(
    raw?.vod_content || raw?.vod_blurb || raw?.vod_remarks || raw?.vod_des || raw?.des || raw?.vod_plot || raw?.remark || ''
  );
  const genre = raw?.vod_class || raw?.vod_tag || raw?.type_name || '';
  const year = raw?.vod_year || raw?.vod_pubdate || raw?.year || '';
  const score = raw?.vod_score || raw?.vod_douban_score || raw?.vod_rate || '';
  // V3.3.4 #3：多线路分组（直链线路排前），默认选集取第一组；线路名随 raw 下发供线路栏显示
  const { lineGroups, lineNames } = toLineGroups(raw);
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
    episodes: lineGroups[0] ?? [],
    desc,
    raw: { ...raw, lineGroups, lineNames },
  };
}

// V3.3.4 #3：多线路分组。LZ 详情实际返回两条线路：
//   vod_play_from = "liangzi$$$lzm3u8"
//   vod_play_url  = "第01集$...share/xxx#第02集$...$$$第01集$https://.../index.m3u8#..."
// 旧 toEpisodes 对整串 split('$$$') 后双层循环摊平成一维——两套"第01集"混排、
// 点第 31 个按钮实际是线路 2 的第 01 集，且线路栏永远只有"默认线路"。
// 现在按线路分组：lineGroups = [[{name,url}...], [...]]（消费端 raw.lineGroups[line] 取第 line 条线路），
// lineNames = ['liangzi','lzm3u8'] 供线路栏显示真实名称。
// 直链线路（m3u8/mp4）排在前面：分享页线路要二次解析、起播慢，默认走直链。
function toLineGroups(raw: any): { lineGroups: { name: string; url: string }[][]; lineNames: string[] } {
  const urlStr = String(raw?.vod_play_url || raw?.vod_url || raw?.play_url || '');
  const fromStr = String(raw?.vod_play_from || '');
  if (!urlStr) return { lineGroups: [], lineNames: [] };
  const groups = urlStr.split('$$$');
  const names = fromStr ? fromStr.split('$$$') : [];
  const parsed = groups
    .map((g, i) => ({ name: names[i] || `线路${i + 1}`, eps: parseEpisodes(g) }))
    .filter((g) => g.eps.length > 0);
  parsed.sort((a, b) => {
    const aDirect = /\.(m3u8|mp4)(\?|$)/i.test(a.eps[0]?.url ?? '') ? 0 : 1;
    const bDirect = /\.(m3u8|mp4)(\?|$)/i.test(b.eps[0]?.url ?? '') ? 0 : 1;
    return aDirect - bDirect;
  });
  return { lineGroups: parsed.map((g) => g.eps), lineNames: parsed.map((g) => g.name) };
}

// 单条线路的选集解析："第01集$url1#第02集$url2"。裸 URL（无 $ 分隔）显示为"第N集"，
// 不再把整条地址当集名（旧版 bug）。
function parseEpisodes(group: string): { name: string; url: string }[] {
  if (!group) return [];
  const out: { name: string; url: string }[] = [];
  for (const seg of group.split('#')) {
    if (!seg) continue;
    const idx = seg.indexOf('$');
    if (idx < 0) out.push({ name: `第${out.length + 1}集`, url: seg });
    else out.push({ name: seg.slice(0, idx), url: seg.slice(idx + 1) });
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
      // V3.3.4 #4：旧版"轮询所有线路所有集直到 resolve 出地址"是死逻辑——resolvePlayUrl
      // 解析失败也原样返回 url（truthy），循环永远第一集就 return；真遇到分享页全挂的源，
      // 会逐集试下去（每集一次分享页抓取、超时上限 30s），页面挂死半小时起。
      // 现在只取第一线路第一集，精确解析一次：resolvePlayUrl 的返回与原地址比较判断成败。
      // 注：正常路径（LZ 等）搜索项已自带直链，播放走 playUrl 直连，本方法只在
      // 历史项/无地址列表项兜底时被调用（resolvePlay: item.playUrl 为空才进来）。
      const data = await apiJson(endpoint, { ac: 'detail', ids: itemId });
      const v = (data?.list ?? [])[0];
      if (!v) return { url: '' };
      const { lineGroups } = toLineGroups(v);
      const first = lineGroups[0]?.[0];
      if (!first?.url) return { url: '' };
      const resolved = await resolvePlayUrl(first.url);
      return { url: resolved || first.url, headers: { Referer: endpoint + '/' } };
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
