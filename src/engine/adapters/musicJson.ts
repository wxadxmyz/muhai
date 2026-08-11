// music-json 适配器：通用音乐 JSON API
import { fetchJson, withTimeout } from '../http';
import { MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';

// 默认字段映射，可用 config.extra.fieldMap 覆盖
const DEFAULT_MAP = {
  id: 'id',
  title: 'name',
  artist: 'artist',
  cover: 'pic',
  url: 'url',
};

export function createMusicJsonSource(cfg: SourceConfig): MediaSource {
  const map = { ...DEFAULT_MAP, ...(cfg.extra?.fieldMap ?? {}) };
  const get = (obj: any, path: string) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

  return {
    async search(keyword: string, page = 1): Promise<MediaItem[]> {
      const url = `${cfg.baseUrl.replace(/\/$/, '')}/search?keyword=${encodeURIComponent(keyword)}&page=${page}`;
      const data = await withTimeout(fetchJson(url, { timeout: 8000 }), 8000);
      const list = Array.isArray(data) ? data : data?.list ?? data?.data?.list ?? [];
      return list.map((it: any) => ({
        id: String(get(it, map.id)),
        sourceId: cfg.id,
        sourceName: cfg.name,
        title: String(get(it, map.title) ?? '未知'),
        artist: get(it, map.artist),
        cover: get(it, map.cover),
        mediaType: 'music' as const,
        playUrl: get(it, map.url),
        raw: it,
      }));
    },

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      const url = `${cfg.baseUrl.replace(/\/$/, '')}/song/url?id=${encodeURIComponent(itemId)}`;
      const data = await fetchJson(url);
      const u = data?.url ?? data?.data?.url ?? data?.playUrl;
      return { url: u, quality: data?.quality };
    },

    async test(): Promise<boolean> {
      try {
        await withTimeout(fetchJson(`${cfg.baseUrl.replace(/\/$/, '')}/ping`), 6000);
        return true;
      } catch {
        // 退化为搜索空词
        try {
          await withTimeout(this.search('test', 1), 6000);
          return true;
        } catch {
          return false;
        }
      }
    },
  };
}
