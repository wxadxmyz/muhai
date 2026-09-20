import { invoke } from '@tauri-apps/api/core';
import { MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';
import { devLog } from '../../lib/log';

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

function toItems(list: any[], cfg: SourceConfig): MediaItem[] {
  if (!Array.isArray(list)) return [];
  return list.map((v: any) => ({
    id: String(v.vod_id ?? v.id ?? ''),
    sourceId: cfg.id,
    sourceName: cfg.name,
    title: v.vod_name ?? v.name ?? '未命名',
    artist: v.vod_remarks ?? v.type_name ?? '',
    cover: v.vod_pic ?? v.pic ?? '',
    desc: v.vod_content ?? v.vod_blurb ?? '',
    year: v.vod_year ?? '',
    mediaType: 'video' as const,
    raw: v,
  }));
}

export function createDrpy3Source(
  cfg: SourceConfig,
  loadCode: () => Promise<string>,
): MediaSource {
  const jsCfg = cfg as any;
  let inited = false;

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
        payload: { code, key: String(jsCfg.id ?? jsCfg.name ?? 'drpy3'), func, args },
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
      const items = toItems(r?.list ?? [], cfg);
      const it = items[0];
      if (it) {
        const eps = toEpisodesWithFlag(it.raw?.vod_play_url ?? '');
        for (const e of eps) rememberFlag(cfg.id, e.url, e.flag);
        it.episodes = eps.map((e) => ({ name: e.name, url: e.url }));
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
      let flag = flagMap.get(`${cfg.id}|${itemId}`) ?? '';
      let playId = itemId;
      // itemId 是 vod_id（而非集数 url）时，先拉详情取首集
      if (!flag) {
        try {
          const r = await call('detail', [itemId]);
          const first = (r?.list ?? [])[0];
          if (first?.vod_play_url) {
            const eps = toEpisodesWithFlag(first.vod_play_url);
            for (const e of eps) rememberFlag(cfg.id, e.url, e.flag);
            if (eps[0]) {
              flag = eps[0].flag;
              playId = eps[0].url;
            }
          }
        } catch {
          /* 直传 itemId 再试 */
        }
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
      if (!headers) {
        const host = String(jsCfg.ext || jsCfg.api || cfg.baseUrl || '').match(/^https?:\/\/[^/]+/i);
        if (host) headers = { Referer: host[0] + '/' };
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
