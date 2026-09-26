import { invoke } from '@tauri-apps/api/core';
import { MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';
import { devLog } from '../../lib/log';
import { ensureProxyPort, buildProxyUrl } from '../../lib/hlsPlayer';
import { isTauri } from '../../lib/tauriBridge';
import { isNetdiskShare, resolveNetdiskShare } from '../../lib/netdiskShare';

// V3.6.5 #1：jx/parse 二次解析助手。把中间地址经本地流式代理 fetch（代理跟随上游重定向），
// 用回传的 x-proxy-final-url 作为真直链。代理不可用时返回 null（调用方回退原始中间地址）。
async function resolveViaProxy(
  url: string,
  headers?: Record<string, string>
): Promise<string | null> {
  if (!isTauri()) return null;
  const proxied = buildProxyUrl(url, headers ?? null);
  try {
    const res = await fetch(proxied, { method: 'GET' });
    if (!res.ok) return null;
    const finalUrl = res.headers.get('x-proxy-final-url');
    if (finalUrl && finalUrl !== url) return finalUrl;
    return null;
  } catch {
    return null;
  }
}

// V3.7.0 B1：播放地址可播性校验——彻底杜绝「规则 play() 返回网页 HTML 被 hls.js 当 m3u8
// 解析 → manifestParsingError → 永久转圈」。典型场景：360kan 等聚合索引源把播放地址指向
// bilibili/爱奇艺/芒果 等外站播放页，这些站根本不提供 m3u8 直链，规则层也提取不出真直链。
// 判定优先级：① 已知「只返回播放页、不直供媒体」的视频平台域名 → 直接报错（零网络开销）；
//            ② 媒体扩展名（.m3u8/.mp4…）→ 信任，交给 hls.js；
//            ③ 其余 http(s) → 经本地代理做 1 字节探测读 Content-Type，命中 HTML 即报错。
// 返回非空字符串 = 明确的不可播原因（调用方应 throw，而非让它转圈）；返回 null = 放行。
const WEB_PLAYER_HOSTS = [
  'bilibili.com', 'bilibili.cn', 'iqiyi.com', 'iqiyi.cn', 'mgtv.com',
  'v.qq.com', 'youku.com', 'v.youku.com', 'le.com', 'letv.com',
  'sohu.com', 'tudou.com', 'acfun.cn',
];
const MEDIA_EXT_RE = /\.(m3u8|m3u|mp4|ts|flv|webm|mov|m4v|m4a)(\?|#|$)/i;

async function guardPlayable(
  url: string,
  headers?: Record<string, string>
): Promise<string | null> {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (WEB_PLAYER_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
      return '该播放地址是视频平台网页，源不提供可直链播放的视频（360kan 等聚合索引站无 m3u8 直链，请换用可直链源）';
    }
    if (MEDIA_EXT_RE.test(url)) return null; // 有媒体扩展名 → 信任，交给 hls.js
    // 其余：经本地代理轻量探测 Content-Type（Range 只取 1 字节，避免拉整段 mp4）
    if (isTauri()) {
      const proxied = buildProxyUrl(url, headers ?? null);
      const res = await fetch(proxied, { method: 'GET', headers: { Range: 'bytes=0-0' } });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html') || ct.includes('application/xhtml')) {
        return '播放地址返回的是网页而非视频流（源未提供可直链 m3u8/mp4），无法播放';
      }
    }
  } catch {
    /* 探测失败不阻断播放，交由 hls.js 兜底报错 */
  }
  return null;
}

// V3.6.0 drpy3 / drpy2 规则源适配器
//
// 影视仓（TVBox）生态里真正好用的源大多是「蜘蛛源」：源本身是一段 JS 规则，
//   - drpy2 老源：`var rule = { 一级/二级/搜索/推荐 ... }`
//   - drpy3 新源：`export default { meta, rule, home, category, search, detail, play ... }`
// 这些规则依赖宿主提供 jsoup 选择器（pdfh/pdfa/pd/pdfl）、CryptoJS、jinja2、gbk 等能力，
// 幕海原有的裸 QuickJS 沙箱跑不了。V3.6.0 起由 Rust 侧 drpy3 引擎（vendor/drpy3-muhai.bundle.js）
// 承载，本适配器只做「TVBox 结构 ↔ 幕海 MediaItem」的转换。
//
// 六环节（drpy3 宿主对接指南 §3.1）：init / home / category / search / detail / play

/** 判定一段 spider 源码是否为 drpy 规则（是则走 drpy3 引擎，否则走原裸脚本沙箱） */
export function isDrpyRule(code: string): boolean {
  if (!code || code.length > 3_000_000) return false;
  const head = code.slice(0, 3000);
  // 源自带 lang 声明（drpy2 / drpy3 都会在头部 @header 里写）
  if (/lang\s*['"]?\s*:\s*['"]dr[23]['"]/.test(head)) return true;
  // drpy2 经典形态
  if (/^\s*var\s+rule\s*=/m.test(code)) return true;
  // drpy3 模块化形态
  if (/\bdefineSource\s*\(/.test(code)) return true;
  // export default { meta, rule } 形态
  if (/^\s*export\s+default\s*[\{\(]/m.test(code) && /\b(meta|rule)\s*:/.test(code)) return true;
  return false;
}

// 集数 → 线路 flag 映射。drpy3 的 play(flag, id, flags) 需要线路名，
// 而幕海播放器只把「集数 url」传回来，故在拉详情时把 url→flag 记下来。
// key = `${sourceId}|${集数url}`
const flagMap = new Map<string, string>();
function rememberFlag(sourceId: string, url: string, flag: string) {
  if (!url) return;
  if (flagMap.size > 4000) flagMap.clear();
  flagMap.set(`${sourceId}|${url}`, flag);
}

// V3.6.5 #4：首集映射。key = `${sourceId}|${vod_id}`，value = 该剧首集的 {flag, url}。
// 场景：详情页/列表已经拿到过集数，播放器再按 vod_id 调 getPlayUrl 时，直接取这里记录的首集，
// 不再重复 call('detail') 拉一次详情（旧实现每次播放都要多一次往返，慢且浪费源站请求）。
const firstEpMap = new Map<string, { flag: string; url: string }>();
function rememberFirstEp(sourceId: string, vodId: string, eps: EpisodeWithFlag[]) {
  if (!vodId || !eps.length) return;
  if (firstEpMap.size > 2000) firstEpMap.clear();
  firstEpMap.set(`${sourceId}|${vodId}`, { flag: eps[0].flag, url: eps[0].url });
}

export interface EpisodeWithFlag {
  name: string;
  url: string;
  flag: string;
}

/** TVBox 选集格式：线路1$名称1$url1#名称2$url2$$$线路2$名称3$url3#... */
export function toEpisodesWithFlag(playUrl: string): EpisodeWithFlag[] {
  if (!playUrl) return [];
  const out: EpisodeWithFlag[] = [];
  for (const group of playUrl.split('$$$')) {
    if (!group) continue;
    // 首段可能是线路名（group 内第一个 $ 之前）；也可能直接就是 名称$url
    const segs = group.split('#').filter(Boolean);
    let flag = '';
    for (const seg of segs) {
      const parts = seg.split('$');
      if (parts.length >= 3) {
        // 线路名$名称$url
        flag = parts[0];
        out.push({ name: parts[1], url: parts.slice(2).join('$'), flag });
      } else if (parts.length === 2) {
        out.push({ name: parts[0], url: parts[1], flag });
      } else {
        out.push({ name: seg, url: seg, flag });
      }
    }
  }
  return out;
}

// V3.8.4 #1：drpy 源详情也按 vod_play_from / vod_play_url 构造 lineGroups/lineNames，
// 让播放器线路切换、首集默认都复用与苹果CMS normal 源一致的逻辑。
// 直链占比高的线路排在前面，避免默认选中分享页/中间页线路导致「无法播放」。
function lineDirectScore(eps: { name: string; url: string }[]): number {
  if (!eps.length) return 0;
  const direct = eps.filter((e) => /\.(m3u8|mp4)(\?|$)/i.test(e.url)).length;
  return direct / eps.length;
}

function parseOneLine(group: string): { name: string; url: string }[] {
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

export function toLineGroups(raw: any): {
  lineGroups: { name: string; url: string }[][];
  lineNames: string[];
  episodes: EpisodeWithFlag[];
} {
  const urlStr = String(raw?.vod_play_url || raw?.vod_url || raw?.play_url || '');
  const fromStr = String(raw?.vod_play_from || '');
  if (!urlStr) return { lineGroups: [], lineNames: [], episodes: [] };
  const groups = urlStr.split('$$$');
  const names = fromStr ? fromStr.split('$$$') : [];
  const parsed = groups
    .map((g, i) => ({ name: names[i] || `线路${i + 1}`, eps: parseOneLine(g) }))
    .filter((g) => g.eps.length > 0);
  parsed.sort((a, b) => {
    const sa = lineDirectScore(a.eps);
    const sb = lineDirectScore(b.eps);
    if (sa !== sb) return sb - sa;
    const aDirect = /\.(m3u8|mp4)(\?|$)/i.test(a.eps[0]?.url ?? '') ? 0 : 1;
    const bDirect = /\.(m3u8|mp4)(\?|$)/i.test(b.eps[0]?.url ?? '') ? 0 : 1;
    return aDirect - bDirect;
  });
  // episodes 保持 flat（兼容旧消费方），但按线路顺序把直链线路的集数放前面
  const episodes: EpisodeWithFlag[] = [];
  for (const g of parsed) {
    for (const e of g.eps) episodes.push({ ...e, flag: g.name });
  }
  return { lineGroups: parsed.map((g) => g.eps), lineNames: parsed.map((g) => g.name), episodes };
}

function toItems(list: any[], cfg: SourceConfig): MediaItem[] {
  if (!Array.isArray(list)) return [];
  return list.map((v: any) => {
    const id = String(v.vod_id ?? v.id ?? '');
    // V3.6.5 #4：搜索/分类列表里若已带 vod_play_url，就地解析出集数并记住 flag 与首集。
    // 这样①列表卡片能直接显示「更新至 N 集」，②播放时可复用首集，省掉一次 detail 往返。
    // V3.8.5 #1：列表/搜索项自带选集时，用与详情一致的 toLineGroups（按直链占比排序、
    // 线路名作 flag）解析，而非未排序的 toEpisodesWithFlag 摊平。否则「分享页线路」会排在
    // 「直链线路」前面（如 lzi 的 vod_play_from = "liangzi$$$lzm3u8"），firstEpMap 记成已失效
    // 的分享页 URL → play 去死链抠 m3u8 → 「能搜不能播 / 未取到可播放地址」。直链优先后，
    // 搜索卡片也能直接起播，省一次 detail 往返。
    const { episodes: eps } = toLineGroups(v);
    for (const e of eps) rememberFlag(cfg.id, e.url, e.flag);
    if (eps.length) rememberFirstEp(cfg.id, id, eps);
    return {
      id,
      sourceId: cfg.id,
      sourceName: cfg.name,
      title: v.vod_name ?? v.name ?? '未命名',
      artist: v.vod_remarks ?? v.type_name ?? '',
      cover: v.vod_pic ?? v.pic ?? '',
      desc: v.vod_content ?? v.vod_blurb ?? '',
      year: v.vod_year ?? '',
      mediaType: 'video' as const,
      episodes: eps.length ? eps.map((e) => ({ name: e.name, url: e.url })) : undefined,
      raw: v,
    };
  });
}

/**
 * 从 spider 源码里抽取源「真实 host」。
 * drpy2：`var rule = { host: 'https://www.360kan.com', ... }`
 * drpy3：`export default { meta:{host:'...'}, rule:{...} }` 或 `host:'https://...'`
 * 用作 play 结果的 Referer —— 绝不能用 cfg.baseUrl（那是 gitee 规则文件地址，不是媒体站）。
 */
function extractRuleHost(code: string): string {
  const m = String(code || '').match(/host\s*[:=]\s*['"](https?:\/\/[^'"]+)['"]/i);
  return m ? m[1].replace(/\/+$/, '') : '';
}

export function createDrpy3Source(
  cfg: SourceConfig,
  loadCode: () => Promise<string>,
): MediaSource {
  const jsCfg = cfg as any;
  let inited = false;
  // 源真实 host（从规则脚本解析，用于 play 补 Referer），懒加载并缓存一次
  let ruleHost = '';
  async function ensureRuleHost(): Promise<string> {
    if (ruleHost) return ruleHost;
    try {
      const code = await loadCode();
      ruleHost = extractRuleHost(code);
    } catch {
      /* 忽略：解析不到就用引擎 play 返回的 header */
    }
    return ruleHost;
  }

  async function call(func: string, args: unknown[]): Promise<any> {
    const code = await loadCode();
    if (!inited && func !== 'init') {
      try {
        await call('init', ['']);
      } catch {
        /* init 失败不阻断：部分源无 init 实现 */
      }
    }
    if (func === 'init') inited = true;
    let raw: string;
    try {
      raw = await invoke<string>('drpy3run', {
        payload: { code, key: String(jsCfg.id ?? jsCfg.name ?? 'drpy3'), func, args, ext: jsCfg.ext },
      });
    } catch (e: any) {
      const msg = `drpy3 ${func} 调用失败: ${e?.message ?? e}`;
      devLog(`[drpy3] ${jsCfg.name} ${msg}`);
      throw new Error(msg);
    }
    devLog(`[drpy3] ${jsCfg.name} ${func} 返回长度=${raw.length}`);
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  async function ensureInit() {
    if (inited) return;
    try {
      await call('init', ['']);
    } catch {
      /* 忽略 */
    }
    inited = true;
  }

  /**
   * V3.6.7 修复④：单集片播放地址兜底。
   *
   * 场景：电影 / 动漫剧场版等单片，源在 detail 阶段往往**不返回 vod_play_url**
   * （地址要到 play 阶段才现算）。旧实现据此返回空 episodes，前端 openDetail 又只认
   * episodes（列表项同样无地址），于是「能搜到、点进去没集数」。
   *
   * 做法：detail 无地址时，用 vod_id 直接调一次 play 取真地址，返回可播放的单集。
   * 注意与 getPlayUrl 的区别——这里只负责「拿到地址 + 构造 1 集」，不做 jx 二次解析
   * （那一步在真正播放时由 getPlayUrl 统一处理，避免详情阶段多耗一次网络往返）。
   */
  async function fetchSinglePlayable(vodId: string, raw: any): Promise<EpisodeWithFlag | null> {
    if (!vodId) return null;
    // 线路 flag：优先源在 detail/列表里给的 vod_play_from（如 lzm3u8）；
    // 部分源不给 from，此时留空由源自行决定（drpy 引擎的 play 对空 flag 也能处理）。
    const fromStr = String(raw?.vod_play_from ?? '');
    const flag = fromStr.split('$$$')[0] ?? '';
    try {
      const r = await call('play', [flag, vodId, []]);
      if (r && r.__drpy3_error) return null;
      let url = '';
      if (typeof r === 'string') url = r;
      else if (r && typeof r === 'object') {
        if (typeof r.url === 'string' && r.url) url = r.url;
        else if (Array.isArray(r.urls) && typeof r.urls[1] === 'string') url = r.urls[1];
      }
      // 必须是可播放地址才认（排除中间页/空值；jx 类型保留 url，由 getPlayUrl 再解析）
      if (!url || !/^https?:\/\//i.test(url)) return null;
      // 单片命名：剧场版/电影统一显示「正片」；若源给了集名则尊重源
      const name = String(raw?.vod_remarks ?? '').trim() || '正片';
      return { name, url, flag };
    } catch {
      return null;
    }
  }

  return {
    async search(keyword: string, page?: number): Promise<MediaItem[]> {
      await ensureInit();
      const r = await call('search', [keyword, false, String(page ?? 1)]);
      if (r && r.__drpy3_error) throw new Error(String(r.__drpy3_error.error ?? '搜索失败'));
      return toItems(r?.list ?? [], cfg);
    },

    async home(): Promise<MediaItem[]> {
      await ensureInit();
      const h = await call('home', ['']);
      const classes: any[] = Array.isArray(h?.class) ? h.class : [];
      if (!classes.length) return [];
      // drpy3 的 home 只返回「分类表」，首页内容要再按分类拉一级列表。
      // 取前两个分类各一页，够首页铺一屏，也不至于拖慢聚合。
      const out: MediaItem[] = [];
      for (const c of classes.slice(0, 2)) {
        try {
          const r = await call('category', [String(c.type_id), '1', false, {}]);
          out.push(...toItems(r?.list ?? [], cfg));
        } catch {
          /* 单个分类失败不影响其它 */
        }
      }
      return out;
    },

    async getDetail(itemId: string): Promise<MediaItem> {
      await ensureInit();
      const r = await call('detail', [itemId]);
      // #4 错误显化：引擎返回的结构化错误必须抛出来，与 search/getPlayUrl 行为一致，
      // 否则前端拿到空详情还以为是源没数据，定位极难。
      if (r && r.__drpy3_error) throw new Error(String(r.__drpy3_error.error ?? '获取详情失败'));
      // #3 裸 VOD 兜底：部分 drpy2 源 detail 直接返回裸 VOD 对象（不带 {list:[...]} 包裹），
      // 此时 r.list 缺失，需把 r 本身当作单条结果处理。
      let list: any[] = Array.isArray(r?.list) ? r.list : [];
      if (list.length === 0 && r && (r.vod_id != null || r.vod_name != null || r.vod_play_url != null)) {
        list = [r];
      }
      const items = toItems(list, cfg);
      const it = items[0];
      if (it) {
        // V3.8.4 #1：用与 normal 源一致的 lineGroups/lineNames 解析，直链线路优先，
        // 同时把 flag 写进 episodes 供 getPlayUrl 使用。
        const { lineGroups, lineNames, episodes: eps } = toLineGroups(it.raw);
        for (const e of eps) rememberFlag(cfg.id, e.url, e.flag);
        rememberFirstEp(cfg.id, itemId, eps); // #4：记住首集，播放时无需再拉详情
        it.episodes = eps.map((e) => ({ name: e.name, url: e.url }));
        it.raw = { ...it.raw, lineGroups, lineNames };
      }
      // V3.6.7 修复④：电影 / 动漫剧场版等「单集片」在 detail 阶段常常不给 vod_play_url
      // （地址要到 play 阶段才现算）。旧实现在这里直接返回空 episodes，前端 openDetail 又
      // 只信 episodes（列表项同样没有地址），于是「能搜到、点进去没集数」。
      // 这里补一条兜底：detail 无播放地址时，直接用 vod_id 调一次 play 取真地址，
      // 构造出「1 集」结构，让播放器能正常起播与显示。
      if (it && (it.episodes?.length ?? 0) === 0) {
        const fallback = await fetchSinglePlayable(itemId, it.raw);
        if (fallback) {
          it.episodes = [{ name: fallback.name, url: fallback.url }];
          rememberFlag(cfg.id, fallback.url, fallback.flag);
          rememberFirstEp(cfg.id, itemId, [fallback]);
          // 同步写回 raw，供 lineGroups 消费方（VideoApp.playEpisode）读取
          it.raw = { ...(it.raw ?? {}), vod_play_url: `${fallback.name}$${fallback.url}`, vod_play_from: fallback.flag };
        }
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
      await ensureInit();
      const isHttpUrl = (s: string) => /^https?:\/\//i.test(s);
      const isDirect = (s: string) => /\.(m3u8|mp4)(\?|$)/i.test(s);
      let flag = flagMap.get(`${cfg.id}|${itemId}`) ?? '';
      let playId = itemId;
      // V3.6.5 #4：先查首集映射（详情页/列表已拉过集数时命中），命中即直接用，
      // 跳过下面那次 detail 往返。这是「播放慢」的一个隐性开销：每次播放都多拉一次详情。
      const first = firstEpMap.get(`${cfg.id}|${itemId}`);
      if (!flag && first?.url) {
        flag = first.flag;
        playId = first.url;
      }
      // V3.8.5 #1：首集缓存为空，或缓存的是「分享页 / 中间地址」（非直链）时，拉一次 detail，
      // 用 toLineGroups 选直链占比最高的线路（与详情页一致）。否则一旦缓存的是失效分享页 URL
      // （如 lzi 的 liangzi 线路），直接 play 必然失败 → 「能搜不能播 / 未取到可播放地址」。
      // 直链首集则直接用，跳过这次 detail，不增加额外耗时。
      if (!isDirect(playId)) {
        try {
          const r = await call('detail', [itemId]);
          const first = (r?.list ?? [])[0];
          const raw = first ?? (r && (r.vod_id != null || r.vod_play_url != null) ? r : null);
          if (raw) {
            const { episodes: eps } = toLineGroups(raw);
            for (const e of eps) rememberFlag(cfg.id, e.url, e.flag);
            if (eps[0]) {
              flag = eps[0].flag;
              playId = eps[0].url;
              devLog(`[drpy3] ${jsCfg.name} detail 兜底取首集: flag=${flag}, url=${playId}`);
            }
          }
        } catch (e: any) {
          devLog(`[drpy3] ${jsCfg.name} detail 兜底失败: ${e?.message ?? e}`);
        }
      }
      // 最后一道防线：playId 仍然不是合法 URL，直接报错而不是把脏数据丢给播放器。
      if (!isHttpUrl(playId)) {
        throw new Error('该源未返回可播放地址（详情缺少选集链接）');
      }
      const r = await call('play', [flag, playId, []]);
      if (r && r.__drpy3_error) throw new Error(String(r.__drpy3_error.error ?? '解析播放地址失败'));
      let url = '';
      let headers: Record<string, string> | undefined;
      if (typeof r === 'string') url = r;
      else if (r && typeof r === 'object') {
        if (typeof r.url === 'string' && r.url) url = r.url;
        else if (Array.isArray(r.urls) && typeof r.urls[1] === 'string') url = r.urls[1];
        if (r.header && typeof r.header === 'object') headers = r.header;
      }
      // V3.8.4 #1：play() 返回的不是可播放 URL（如返回了 vod_id 字符串、空字符串），
      // 尝试再拉一次 detail 取首集直链。仍失败则明确报错，不再把脏数据塞给播放器。
      if (!isHttpUrl(url)) {
        devLog(`[drpy3] ${jsCfg.name} play 返回非 URL: "${url}", 尝试 detail 兜底`);
        try {
          const d = await call('detail', [itemId]);
          const first = (d?.list ?? [])[0];
          const raw = first ?? (d && (d.vod_id != null || d.vod_play_url != null) ? d : null);
          if (raw) {
            const { episodes: eps } = toLineGroups(raw);
            if (eps[0]?.url && isHttpUrl(eps[0].url)) {
              url = eps[0].url;
              flag = eps[0].flag;
              devLog(`[drpy3] ${jsCfg.name} detail 兜底取到 URL: ${url}`);
            }
          }
        } catch (e: any) {
          devLog(`[drpy3] ${jsCfg.name} detail 兜底失败: ${e?.message ?? e}`);
        }
      }
      if (!isHttpUrl(url)) {
        throw new Error('该源未返回可播放地址（解析结果不是有效视频链接）');
      }
      if (!headers) {
        // #5 Referer 修正：优先用源真实 host（ext/api 是源站接口地址，ruleHost 是从规则脚本解析的媒体站 host）。
        // 旧逻辑用 cfg.baseUrl —— 那其实是 gitee 规则文件地址，既不是源站也不是媒体站，作为 Referer 会让
        // 大量需要校验 Referer 的站点（如 360kan / iqiyi）直接拒绝播放。故去掉 cfg.baseUrl 兜底。
        const extHost = String(jsCfg.ext || jsCfg.api || '').match(/^https?:\/\/[^/]+/i)?.[0];
        const host = extHost || (await ensureRuleHost());
        if (host) headers = { Referer: host.replace(/\/+$/, '') + '/' };
      }
      // V3.6.5 #1：jx/parse 二次解析。defaults.play 对需嗅探/回解的源会返回
      // { jx:1, parse:1, url:<中间地址> }；旧实现只取 r.url 直接返回，没走真解析，
      // 导致这类源拿到的是中间页而非可播放真直链。这里：r.jx/r.parse 为真时，
      // 把 r.url 经本地流式代理 fetch（代理会跟随重定向），用回传的 x-proxy-final-url
      // 作为真直链；覆盖绝大多数「jx 重定向到真实 CDN」的影视仓源。
      const needJx = Boolean((r as any)?.jx) || Boolean((r as any)?.parse);
      if (needJx && url && /^https?:\/\//i.test(url)) {
        try {
          await ensureProxyPort();
          const real = await resolveViaProxy(url, headers);
          if (real) {
            devLog(`[drpy3] jx/parse 解析中间地址 ${url} → 真直链 ${real}`);
            url = real;
          }
        } catch (e: any) {
          devLog(`[drpy3] jx/parse 解析失败，回退中间地址:`, e?.message ?? e);
        }
      }
      // V3.7.0 B1：最终地址可播性校验（见 guardPlayable）——网页/非媒体一律明确报错，
      // 不再把 HTML 喂给 hls.js 导致永久转圈。
      // V3.7.4 #1：guard 命中「网页/非媒体」时，先经本地代理跟随重定向解析一次真直链
      // （覆盖金鹰类「分享页/中间地址」源——其 play() 偶发返回中间页被误杀，重试又成功）。
      // 解析成功且不再是网页则放行，否则保持原错误抛出，不会引入新风险。
      // V3.7.5 #4：play() 返回的是网盘分享链接（阿里/夸克）时，先经网盘解析模块换成直链。
      // 解析成功得到可播直链则替换 url，失败回退到 guard 的原有报错路径。
      if (url && /^https?:\/\//i.test(url) && isNetdiskShare(url)) {
        try {
          await ensureProxyPort();
          const real = await resolveNetdiskShare(url);
          if (real) {
            devLog(`[drpy3] 网盘分享链接 ${url} → 直链 ${real}`);
            url = real;
          }
        } catch (e: any) {
          devLog(`[drpy3] 网盘分享解析失败，回退原行为:`, e?.message ?? e);
        }
      }
      if (url && /^https?:\/\//i.test(url)) {
        let guardErr = await guardPlayable(url, headers);
        if (guardErr) {
          try {
            await ensureProxyPort();
            const real = await resolveViaProxy(url, headers);
            if (real && real !== url) {
              const re = await guardPlayable(real, headers);
              if (!re) { url = real; guardErr = null; }
            }
          } catch {
            /* 解析失败，保持原 guardErr 继续报错 */
          }
        }
        if (guardErr) throw new Error(guardErr);
      }
      return { url, headers };
    },

    async test(): Promise<boolean> {
      try {
        await loadCode();
        await ensureInit();
        return true;
      } catch {
        return false;
      }
    },
  };
}
