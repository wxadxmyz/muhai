// v2.3.0 tvbox / 影视仓聚合源适配器（重写版，已删除苹果CMS 协议）
//
// 旧版按苹果CMS 风格 GET {api}?ac=list&wd= 抓列表，对蜘蛛源/加密源全部失效。
// 新版：把 tvbox 配置（含 XC.json 风格整体加密配置）解析后，收集其中所有
// 「带 spider 脚本」的源（顶层 spider / 各站点 spider / 远程脚本 api），
// 全部委托 createJsSource 在统一 JS 引擎里执行。
//   - 蜘蛛源（csp_* 需用户提供对应 spider 脚本，本 App 不内置蜘蛛库）
//   - 加密源（XC.json 等整体密文）：本 App 不做第三方解密，密文配置按无源处理
//
// 抓取统一走 Rust 后端 fetchsource 代理，绕开 Android WebView 的 CORS 与明文 HTTP 限制。
import { invoke } from '@tauri-apps/api/core';
import { LiveChannelSource, MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';
import { createJsSource } from './js';

async function fetchText(url: string): Promise<string> {
  try {
    return await invoke<string>('fetchsource', { url });
  } catch {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}

// 去掉 TVBox spider 地址常见的 ";md5;<hash>" 校验后缀
function stripMd5(u: string): string {
  return String(u).split(';md5;')[0];
}

// 把相对路径 spider 引用解析成绝对 URL（针对 ddys-tvbox 之类的 "./spider/x.js"）
function resolveUrl(ref: string, base: string): string {
  if (/^https?:\/\//i.test(ref)) return ref;
  try { return new URL(ref, base).toString(); } catch { return ref; }
}

// 问题 #10 修复：TVBox 配置普遍是带 // 行注释、/* */ 块注释的 JS 风格文本，
// 标准 JSON.parse 会直接抛错，导致整个源被当无效源跳过（实测清单里 xhztv、
// raw.liucn.cc/box/m、二月红 等首选源就带大量注释）。解析前先剥离注释再 parse。
function stripJsonComments(text: string): string {
  // 先清理字符串值内的裸换行/Tab（TVBox 配置偶发未转义换行，JSON 不允许）
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
      out += ' '; // 字符串内换行/Tab 转空格
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

// 把 spider 字段归一为 {spider 内联代码 | spiderUrl 远程地址}
function spiderField(v: any): { spider?: string; spiderUrl?: string } {
  if (typeof v !== 'string') return { spider: JSON.stringify(v) };
  if (/^https?:\/\//i.test(v)) return { spiderUrl: stripMd5(v) };
  return { spider: v };
}

// 从 tvbox 配置收集所有可执行的 spider 源（支持 TVBox csp 模型）
async function collectSpiders(cfg: SourceConfig): Promise<SourceConfig[]> {
  const text = await fetchText(cfg.baseUrl);
  let data: any;
  try {
    data = JSON.parse(stripJsonComments(text));
  } catch {
    // 配置无法解析为 JSON：本 App 不内置/不依赖第三方解密（已移除饭太硬 jiemi.php 依赖），
    // 密文配置直接按无源处理，避免发出无谓的外部请求与超时。
    return [];
  }

  // 单线路（无 sites 数组）：顶层 spider 即唯一源；
  // drpy2 单文件形态：顶层 api 直接是远程 .js 蜘蛛脚本
  if (!Array.isArray(data.sites)) {
    if (data.spider) {
      const sf = spiderField(data.spider);
      return [{ ...cfg, type: 'js', name: cfg.name, ...sf } as SourceConfig];
    }
    if (typeof data.api === 'string' && /\.js(\?|$)/i.test(data.api)) {
      return [{ ...cfg, type: 'js', name: cfg.name, spiderUrl: resolveUrl(stripMd5(data.api), cfg.baseUrl) } as SourceConfig];
    }
    return [];
  }

  // 多站点：顶层 spider 为共享蜘蛛（通常是一个远程 JS 脚本地址，需剥离 ;md5;），
  // 各站点通过 api(类名) + ext(站点配置) 选路；无自有 spider 的站点继承顶层 spider。
  let sharedCode: string | null = null;
  if (data.spider) {
    const sf = spiderField(data.spider);
    if (sf.spider) {
      sharedCode = sf.spider;
    } else if (sf.spiderUrl) {
      try {
        sharedCode = await fetchText(resolveUrl(sf.spiderUrl, cfg.baseUrl)); // 预先取回共享蜘蛛，避免每站点重复拉取
      } catch {
        sharedCode = null;
      }
    }
  }

  const out: SourceConfig[] = [];
  for (const s of data.sites) {
    // drpy2 形态：站点 api 为远程 .js 蜘蛛脚本（如 ".../drpy2.min.js"），亦纳入
    const sf = s.spider
      ? spiderField(s.spider)
      : s.spiderUrl
        ? { spiderUrl: resolveUrl(stripMd5(s.spiderUrl), cfg.baseUrl) }
        : typeof s.api === 'string' && /\.js(\?|$)/i.test(s.api)
          ? { spiderUrl: resolveUrl(stripMd5(s.api), cfg.baseUrl) }
          : null;
    let spider = sf?.spider ?? null;
    const spiderUrl = sf?.spiderUrl ?? null;
    if (!spider && !spiderUrl && sharedCode) spider = sharedCode; // 继承共享蜘蛛
    if (!spider && !spiderUrl) continue; // 既无自有也无共享蜘蛛，跳过
    const subId = s.key ? `${cfg.id}::${s.key}` : `${cfg.id}::${out.length}`;
    out.push({
      ...cfg,
      id: subId, // 子站唯一 id，供前端按子站过滤/标记
      parentId: cfg.id, // 记录所属配置，便于错误归类
      type: 'js',
      name: s.name || s.key || cfg.name,
      spider: spider ?? undefined,
      spiderUrl: spiderUrl ?? undefined,
      api: s.api,
      // 仅序列化一次：直接传原始 ext（字符串/JSON 字符串），由 Rust 端 run_spider
      // 统一用 serde_json::to_string 生成合法 JSON 字面量注入 QuickJS，避免双重序列化
      // 导致 JSON.parse 抛错、drpy2/csp 站点（如 ext=douban.js）初始化失败（问题 #1/#2）。
      ext: s.ext ?? undefined,
    } as SourceConfig);
  }
  return out;
}

// 供前端使用的子站展开入口（无缓存版本，需上层做整体缓存）
export async function expandTvboxSpiders(cfg: SourceConfig): Promise<SourceConfig[]> {
  return collectSpiders(cfg);
}

export function createTvboxSource(cfg: SourceConfig): MediaSource {
  async function spiders(): Promise<MediaSource[]> {
    const cfgs = await collectSpiders(cfg);
    return cfgs.map((c) => createJsSource(c));
  }

  return {
    async search(keyword: string): Promise<MediaItem[]> {
      const cfgs = await collectSpiders(cfg);
      if (!cfgs.length) {
        throw new Error('该 tvbox 配置无可用的 spider 脚本源（csp_* 蜘蛛代号需提供对应 spider 脚本）');
      }
      const srcs = cfgs.map((c) => createJsSource(c));
      // v2.4.2：收集每个子站的具体错误，不再吞掉，最终抛出代表性原因，
      // 让前端"该源未连通"能直接显示为什么失败（无需 root/logcat）。
      const errors: string[] = [];
      const results = await Promise.all(
        cfgs.map(async (c, i) => {
          try {
            return await srcs[i].search(keyword);
          } catch (e: any) {
            errors.push(`${c.name}: ${e?.message ?? '搜索失败'}`);
            return [] as MediaItem[];
          }
        })
      );
      const items = results.flat();
      if (!items.length) {
        const detail = errors.length ? errors.slice(0, 3).join('；') : '所有 spider 源均未返回结果';
        throw new Error(`未从任何 spider 源获取到结果（${detail}）`);
      }
      return items;
    },

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      const srcs = await spiders();
      for (const s of srcs) {
        try {
          const r = await s.getPlayUrl(itemId);
          if (r.url) return r;
        } catch {
          /* 尝试下一个源 */
        }
      }
      return { url: '' };
    },

    async getDetail(itemId: string) {
      const srcs = await spiders();
      for (const s of srcs) {
        try {
          const r = await s.getDetail(itemId);
          if (r && r.title) return r;
        } catch {
          /* 尝试下一个源 */
        }
      }
      return {
        id: itemId,
        sourceId: cfg.id,
        sourceName: cfg.name,
        title: '',
        mediaType: 'video' as const,
      };
    },

    async test(): Promise<boolean> {
      const srcs = await spiders();
      return srcs.length > 0;
    },

    // 首页推荐：各 spider 源首页合并（有源主页"站点推荐"用）
    async home(): Promise<MediaItem[]> {
      const cfgs = await collectSpiders(cfg);
      const srcs = cfgs.map((c) => createJsSource(c));
      const errors: string[] = [];
      const results = await Promise.all(
        cfgs.slice(0, 6).map(async (c, i) => {
          try {
            return await srcs[i].home!();
          } catch (e: any) {
            errors.push(`${c.name}: ${e?.message ?? '首页加载失败'}`);
            return [] as MediaItem[];
          }
        })
      );
      const items = results.flat();
      if (!items.length && errors.length) {
        throw new Error(`首页加载失败（${errors.slice(0, 3).join('；')}）`);
      }
      return items;
    },

    // 直播源：返回配置中的 lives[]
    async lives(): Promise<LiveChannelSource[]> {
      try {
        const data = JSON.parse(await fetchText(cfg.baseUrl));
        return Array.isArray(data?.lives) ? data.lives : [];
      } catch {
        return [];
      }
    },
  };
}
