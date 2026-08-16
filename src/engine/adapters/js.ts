import { invoke } from '@tauri-apps/api/core';
import { LiveChannelSource, MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';

// v2.3.0 统一 JS 引擎源适配器
// 执行 spider 脚本驱动任意影视源（蜘蛛源 / 加密源）。脚本经 Rust run_spider 命令在
// QuickJS 沙箱内运行，网络请求由 fetch 桥接回 Rust 代理（绕开 CORS）。
// spider 约定函数：home() / search(key) / detail(id) / play(url)
// 返回遵循 TVBox 标准：{ list:[{ vod_id, vod_name, vod_pic, vod_remarks, vod_play_url }] }

export function createJsSource(cfg: SourceConfig): MediaSource {
  const jsCfg = cfg as any;
  let cachedCode: string | null = null;

  async function loadCode(): Promise<string> {
    if (cachedCode) return cachedCode;
    if (jsCfg.spider) {
      cachedCode = jsCfg.spider;
      return cachedCode;
    }
    if (jsCfg.spiderUrl) {
      const txt = await invoke<string>('fetchsource', { url: jsCfg.spiderUrl });
      cachedCode = txt;
      return cachedCode;
    }
    if (jsCfg.api) {
      // 兼容影视仓配置：api 字段可能直接是远程 spider 脚本地址
      const txt = await invoke<string>('fetchsource', { url: jsCfg.api });
      cachedCode = txt;
      return cachedCode;
    }
    throw new Error('JS 源缺少 spider 脚本（需提供 spider / spiderUrl / api 之一）');
  }

  async function call(func: string, args: string[]): Promise<any> {
    const code = await loadCode();
    const raw = await invoke<string>('run_spider', {
      payload: { code, func, args, api: jsCfg.api, ext: jsCfg.ext },
    });
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  function toItems(list: any[]): MediaItem[] {
    if (!Array.isArray(list)) return [];
    return list.map((v: any) => ({
      id: String(v.vod_id ?? v.id ?? ''),
      sourceId: cfg.id,
      sourceName: cfg.name,
      title: v.vod_name ?? v.name ?? '未命名',
      artist: v.vod_remarks ?? v.type_name ?? '',
      cover: v.vod_pic ?? v.pic ?? '',
      mediaType: 'video' as const,
      raw: v,
    }));
  }

  // TVBox 选集格式：选集1$url1#选集2$url2
  function toEpisodes(playUrl: string): { name: string; url: string }[] {
    if (!playUrl) return [];
    return playUrl.split('#').map((seg) => {
      const idx = seg.indexOf('$');
      if (idx < 0) return { name: seg, url: seg };
      return { name: seg.slice(0, idx), url: seg.slice(idx + 1) };
    });
  }

  return {
    async search(keyword: string) {
      const data = await call('search', [keyword]);
      const list = data?.list ?? (Array.isArray(data) ? data : []);
      return toItems(list);
    },

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      const data = await call('play', [itemId]);
      const url = typeof data === 'string' ? data : data?.url ?? '';
      return { url };
    },

    async getDetail(itemId: string) {
      const data = await call('detail', [itemId]);
      const list = data?.list ?? (Array.isArray(data) ? data : []);
      const items = toItems(list);
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

    async test() {
      try {
        await loadCode();
        return true;
      } catch {
        return false;
      }
    },

    async home() {
      const data = await call('home', []);
      const list = data?.list ?? (Array.isArray(data) ? data : []);
      return toItems(list);
    },

    async lives(): Promise<LiveChannelSource[]> {
      try {
        const data = await call('lives', []);
        const arr = Array.isArray(data) ? data : data?.list ?? [];
        return arr.map((l: any) => ({
          name: l.name ?? l.title ?? '直播线路',
          url: l.url,
        })) as LiveChannelSource[];
      } catch {
        return [];
      }
    },
  };
}
