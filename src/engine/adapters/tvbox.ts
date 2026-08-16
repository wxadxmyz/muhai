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

async function fetchText(url: string): Promise<string> {
  try {
    return await invoke<string>('fetchsource', { url });
  } catch {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}

// E5 加密源解密：把整体密文配置还原为 spider 代码。
// 当前为占位实现，返回原文本；XC.json 的 hex→解码→AES/RC4 解密在 E5 补齐。
function tryDecodeConfig(text: string): string {
  const s = text.trim();
  // TODO(E5)：检测纯 hex 密文 → hex 解码 → AES/RC4 解密（对齐 TVBox 算法与 key）→ 返回 spider 代码
  return s;
}

// 从 tvbox 配置收集所有可执行的 spider 源
async function collectSpiders(cfg: SourceConfig): Promise<SourceConfig[]> {
  const text = await fetchText(cfg.baseUrl);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    // 整体密文（XC.json 风格）：解密后作为单个 js 源
    const decoded = tryDecodeConfig(text);
    return [
      { ...cfg, type: 'js', name: cfg.name, spider: decoded } as SourceConfig,
    ];
  }
  const out: SourceConfig[] = [];
  // 顶层 spider（XC.json 风格单线路）
  if (data.spider) {
    out.push({
      ...cfg,
      type: 'js',
      name: cfg.name,
      spider: typeof data.spider === 'string' ? data.spider : JSON.stringify(data.spider),
    } as SourceConfig);
  }
  // 各站点含 spider / 远程脚本 api
  if (Array.isArray(data.sites)) {
    for (const s of data.sites) {
      if (s.spider || (typeof s.api === 'string' && /^https?:\/\//.test(s.api))) {
        out.push({
          ...cfg,
          type: 'js',
          name: s.name || s.key || cfg.name,
          spider: s.spider,
          spiderUrl: s.spiderUrl,
          api: s.api,
        } as SourceConfig);
      }
    }
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
