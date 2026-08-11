// alist 适配器：云盘统一网关（阿里云盘/夸克/UC/115/天翼/移动云盘...）
// 登录仅 Token + 扫码（alist 内完成），App 仅持有 alist API Token。
import { fetchJson, withTimeout } from '../http';
import { MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';

const VIDEO_EXT = ['mp4', 'mkv', 'm3u8', 'ts', 'webm', 'mov', 'flv', 'avi', 'rm', 'rmvb', 'wmv', 'iso'];
const isVideo = (name: string) => VIDEO_EXT.includes((name.split('.').pop() || '').toLowerCase());

export function createAlistSource(cfg: SourceConfig): MediaSource {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = cfg.token ? { Authorization: cfg.token } : {};
  const mountPath = cfg.extra?.mountPath ?? '/';

  return {
    async search(keyword: string): Promise<MediaItem[]> {
      // 优先在挂载目录下搜索
      const data = await withTimeout(
        fetchJson(`${base}/api/fs/search`, {
          method: 'POST',
          headers,
          body: { parent: mountPath, keywords: keyword },
        }),
        8000
      );
      const items = data?.data?.content ?? [];
      return items
        .filter((f: any) => f.type === 2 || isVideo(f.name)) // type 2 = 文件
        .map((f: any) => ({
          id: encodeURIComponent(f.path),
          sourceId: cfg.id,
          sourceName: cfg.name,
          title: f.name,
          cover: undefined,
          mediaType: 'video' as const,
          raw: f,
        })) as MediaItem[];
    },

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      const path = decodeURIComponent(itemId);
      const data = await fetchJson(`${base}/api/fs/get`, {
        method: 'POST',
        headers,
        body: { path },
      });
      const url = data?.data?.raw_url ?? data?.data?.url ?? '';
      return { url, headers };
    },

    async test(): Promise<boolean> {
      try {
        const data = await withTimeout(fetchJson(`${base}/api/me`, { headers }), 6000);
        return data?.code === 0 || !!data?.data;
      } catch {
        return false;
      }
    },
  };
}
