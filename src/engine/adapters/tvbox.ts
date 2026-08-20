// v2.3.0 tvbox / 影视仓聚合源适配器（重写版，已删除苹果CMS 协议）
//
// 旧版按苹果CMS 风格 GET {api}?ac=list&wd= 抓列表，对蜘蛛源/加密源全部失效。
// 新版：把 tvbox 配置（含 XC.json 风格整体加密配置）解析后，收集其中所有
// 「带 spider 脚本」的源（顶层 spider / 各站点 spider / 远程脚本 api），
// 全部委托 createJsSource 在统一 JS 引擎里执行。
//   - 蜘蛛源（csp_* 需用户提供对应 spider 脚本，本 App 不内置蜘蛛库）
//   - 加密源（XC.json）：整体密文由 tryDecodeConfig 解密为 spider 代码（见 E5）
//
// 抓取统一走 Rust 后端 fetchsource 代理，绕开 Android WebView 的 CORS 与明文 HTTP 限制。
import { invoke } from '@tauri-apps/api/core';
import { LiveChannelSource, MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';
import { createJsSource } from './js';
import { getDecryptConfig } from '../../lib/settings';

async function fetchText(url: string): Promise<string> {
  try {
    return await invoke<string>('fetchsource', { url });
  } catch {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}

// E5 加密源解密（v2.3.0 实现）：把"整体加密接口"还原为可读 JSON 配置。
// 采用饭太硬 jiemi.php 服务端解密（App 把加密接口 URL 发给该端点，服务端用私钥解出）。
// 仅当 JSON.parse 失败时触发（即配置是密文），正常 JSON 配置不触发，最小化第三方调用。
// 端点可在「设置」里改/关（getDecryptConfig）。
async function tryDecodeConfig(cfg: SourceConfig): Promise<string> {
  const { enabled, endpoint } = getDecryptConfig();
  if (!enabled || !endpoint) return '';
  try {
    const u = `${endpoint}?url=${encodeURIComponent(cfg.baseUrl)}`;
    const dec = await fetchText(u);
    if (dec && dec.trim().startsWith('{')) return dec; // 解密成功，返回 JSON 文本
  } catch {
    /* 解密失败，返回空，交由上层按无源处理 */
  }
  return '';
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
    data = JSON.parse(text);
  } catch {
    // 整体密文（XC.json 风格）：尝试服务端解密
    const dec = await tryDecodeConfig(cfg);
    if (!dec) return [];
    try {
      data = JSON.parse(dec);
    } catch {
      return [];
    }
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
    out.push({
      ...cfg,
      type: 'js',
      name: s.name || s.key || cfg.name,
      spider: spider ?? undefined,
      spiderUrl: spiderUrl ?? undefined,
      api: s.api,
      ext: s.ext ? JSON.stringify(s.ext) : undefined,
    } as SourceConfig);
  }
  return out;
}

export function createTvboxSource(cfg: SourceConfig): MediaSource {
  async function spiders(): Promise<MediaSource[]> {
    const cfgs = await collectSpiders(cfg);
    return cfgs.map((c) => createJsSource(c));
  }

  return {
    async search(keyword: string): Promise<MediaItem[]> {
      const srcs = await spiders();
      if (!srcs.length) {
        throw new Error('该 tvbox 配置无可用的 spider 脚本源（csp_* 蜘蛛代号需提供对应 spider 脚本）');
      }
      const results = await Promise.all(
        srcs.map(async (s) => {
          try {
            return await s.search(keyword);
          } catch {
            return [] as MediaItem[];
          }
        })
      );
      const items = results.flat();
      if (!items.length) throw new Error('未从任何 spider 源获取到结果');
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
      const srcs = await spiders();
      const results = await Promise.all(
        srcs.slice(0, 6).map(async (s) => {
          try {
            return await s.home!();
          } catch {
            return [] as MediaItem[];
          }
        })
      );
      return results.flat();
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
