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

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  // V3.8.3：取播放页时尽量带浏览器 UA + 源站 Referer，部分源站（云线路 DPlayer 页）对
  // 无 UA/Referer 的请求返回空/403，会导致解析不出 m3u8 而转圈。
  const fallbackHeaders: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    ...(headers ?? {}),
  };
  try {
    return await invoke<string>('fetchsource', { url });
  } catch {
    const res = await fetch(url, { headers: fallbackHeaders, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}

// 取播放页用的浏览器 UA + 同域 Referer
function pageHeaders(url: string): Record<string, string> {
  let ref = '';
  try {
    ref = new URL(url).origin;
  } catch {
    /* ignore */
  }
  return {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    Referer: ref || 'https://www.google.com',
  };
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
// V3.6.7 修复：旧实现只看 `eps[0]`（第一集）。LZ 这类源**两条线路都是 38 集**，
// 首集一个是 share/xxx（分享页）、一个是 index.m3u8（直链），本该直链优先；但若某集
// 顺序错位（首集恰好是分享页而次集是直链），只看 eps[0] 就会把分享页线路排到前面，
// 用户每次点开都要多等一次分享页抓取、且分享页挂掉就整条线路不可用。
// 改为「整条线路中直链占比」评分：占比高的排前面，平局时再看首集。
function lineDirectScore(eps: { name: string; url: string }[]): number {
  if (!eps.length) return 0;
  const direct = eps.filter((e) => /\.(m3u8|mp4)(\?|$)/i.test(e.url)).length;
  return direct / eps.length;
}

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
    const sa = lineDirectScore(a.eps);
    const sb = lineDirectScore(b.eps);
    if (sa !== sb) return sb - sa; // 直链占比高的优先
    // 占比相同：首条是直链的优先（保持旧行为，如「线路A 全直链 vs 线路B 全直链」时顺序稳定）
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

// v2.7.0 自解析：CMS 接口返回的播放地址常常是 HTML 分享页（量子/飞极速/云线路 DPlayer 等），里面
// 内嵌一段 JS：`var main = "/path/index.m3u8?sign=..."` 或同类变量名（`vid` / `url` / `play_url`）。
// 通过抓分享页 → 提取 m3u8 → 用 URL 原域拼装成完整链接，回给播放器 HLS。
// 已经直链（#EXTM3U / .mp4）的原样返回。
export async function resolvePlayUrl(url: string): Promise<string> {
  if (!url) return url;
  if (/\.(m3u8|mp4)(\?|$)/i.test(url)) return url; // 看起来已是直链，省一次请求
  try {
    const text = await fetchText(url, pageHeaders(url));
    if (!text) return url;
    const t = text.trimStart();
    if (t.startsWith('#EXTM3U')) return url; // 已经是 m3u8 文本
    // V3.8.3：常见分享页变量名（支持 var / const / let）。云线路 DPlayer 页用 `const vid='.../index.m3u8'`，
    // 单列出来避免被后面的宽兜底误伤；`player` 配置对象内嵌写法（`"url":"..."`）也覆盖。
    const m =
      text.match(/(?:var|const|let)\s+vid\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
      text.match(/(?:var|const|let)\s+main\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
      text.match(/(?:var|const|let)\s+(?:url|m3u8|play_url|video_url|videoUrl|source)\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
      text.match(/["'](?:url|src|file|source)["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
      text.match(/src\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
      // 更宽的兜底——不管变量名叫什么，页面里只要出现引号包裹的 m3u8 路径就取它。
      // 各家分享页模板的赋值名千奇百怪（已见过 main / vid / playurl / data-url / 直接写在
      // player 配置对象里），按名匹配漏一个就等于整条线路播不了。
      text.match(/["']([^"'\s]*\.m3u8[^"'\s]*)["']/i);
    if (m) {
      const abs = new URL(m[1].replace(/\\\//g, '/'), url).href;
      // 校验：解析结果必须仍是 http(s)。个别分享页里有 m3u8 字样的静态资源
      // （播放器 JS 路径、预加载提示图），命中会拿到 .js/.jpg 之类，直接交给播放器必失败。
      if (/^https?:/i.test(abs)) return abs;
      return url;
    }
    // V3.8.3：页面已取到但里面没有任何 m3u8 地址——明确抛错，
    // 不再把 HTML 页面 URL 丢给播放器导致永久转圈（用户只能干等）。
    throw new Error('该线路解析失败：播放页未包含可播放的 m3u8 地址（源站可能已更换播放页结构）');
  } catch (e: any) {
    // 区分两类失败：明确的"解析失败"向上抛，让播放页/上层显示真实原因；
    // 取页面本身的网络/防盗链错误则回退 URL，由上层 fallback 到 m3u8 直链线路。
    if (e?.message && e.message.includes('解析失败')) throw e;
    return url;
  }
}

export function createNormalSource(cfg: SourceConfig): MediaSource {
  const endpoint = cleanEndpoint(cfg.api || cfg.baseUrl);

  return {
    async search(keyword: string) {
      // V3.4.7 #2：优先用 ac=videolist（返回完整字段，含 vod_pic 封面），失败或空则回退 ac=search（兼容老源）
      try {
        const data = await apiJson(endpoint, { ac: 'videolist', wd: keyword, pg: '1' });
        if (data?.list?.length) return toItems(data.list, cfg);
      } catch {
        /* 落到下面的兜底逻辑 */
      }
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

      // V3.6.7：先看首线路首集是否本就是直链——是则直接用，不必多打一次分享页请求。
      const isDirect = (u: string) => /\.(m3u8|mp4)(\?|$)/i.test(u);
      let picked = first.url;
      let resolved = first.url;
      if (!isDirect(first.url)) {
        try {
          resolved = await resolvePlayUrl(first.url);
        } catch {
          resolved = first.url; // 解析失败：保留原地址，走下方回退逻辑
        }
        // V3.6.7：主线路是分享页且解析失败时，**回退到后续线路的第一集**再试一次。
        // 旧实现解析失败会把分享页 URL 原样交给播放器 → 播放器拿到 HTML → manifestParsingError
        // → 用户只看到「加载失败/转圈」。LZ 这类源往往另有 lzm3u8 直链线路，白放着没用到。
        // 只多试最多 2 条备选，避免重蹈「逐集轮询半小时」的覆辙；每条备选只试 1 集。
        if (resolved === first.url && !isDirect(resolved)) {
          for (let li = 1; li < Math.min(lineGroups.length, 3); li++) {
            const cand = lineGroups[li]?.[0];
            if (!cand?.url) continue;
            if (isDirect(cand.url)) {
              picked = cand.url;
              resolved = cand.url;
              break;
            }
            try {
              const r2 = await resolvePlayUrl(cand.url);
              if (r2 !== cand.url && isDirect(r2)) {
                picked = cand.url;
                resolved = r2;
                break;
              }
            } catch {
              continue; // 该候选解析失败，试下一个
            }
          }
        } else if (resolved !== first.url) {
          picked = first.url;
        }
      }
      // V3.6.6 A1（致命）：Referer 必须按「播放地址自身的 origin」推导，不能用 API 域名。
      // 例：API 是 hhzyapi.com，但真实播放域名是 play.hhuus.com / hn.bfvvs.com / v.gsuus.com。
      // 拿 API 域名当 Referer 与播放域名不同源 → 防盗链校验拒绝 → 永远取不到流 → 永久「加载中」。
      // 源地址（first.url）与解析后地址（resolved）同域时都指向播放站；解析后地址优先（更接近真实资源）。
      const referer = (() => {
        try {
          return new URL(resolved || picked).origin + '/';
        } catch {
          return endpoint + '/'; // 兜底：极少数首集地址非绝对 URL
        }
      })();
      return { url: resolved || picked, headers: { Referer: referer } };
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
