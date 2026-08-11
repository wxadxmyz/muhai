// video-cms 适配器：苹果 CMS 风格影视站
// 搜索: GET {baseUrl}?ac=list&wd={kw}&pg={p}
// 播放地址: vod_play_url = "线路1$urlA#线路2$urlB"
import { fetchJson, withTimeout } from '../http';
import { Episode, MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';

function parsePlayUrl(vodPlayUrl: string): Episode[] {
  if (!vodPlayUrl) return [];
  const eps: Episode[] = [];
  for (const seg of vodPlayUrl.split('#')) {
    const idx = seg.indexOf('$');
    if (idx === -1) continue;
    const name = seg.slice(0, idx);
    const url = seg.slice(idx + 1);
    if (url) eps.push({ name, url });
  }
  return eps;
}

// 影视源多线路以 $$$ 分隔；每条线路内部以 # 分隔剧集
// 例如："线路1$urlA1#urlA2$$$线路2$urlB1#urlB2"
function parsePlayGroups(vodPlayUrl: string): Episode[][] {
  if (!vodPlayUrl) return [];
  const groups = vodPlayUrl.includes('$$$')
    ? vodPlayUrl.split('$$$').map(parsePlayUrl)
    : [parsePlayUrl(vodPlayUrl)];
  return groups.filter((g) => g.length > 0);
}

export function createVideoCmsSource(cfg: SourceConfig): MediaSource {
  const base = cfg.baseUrl.replace(/\/$/, '');

  return {
    async search(keyword: string, page = 1): Promise<MediaItem[]> {
      const url = `${base}?ac=list&wd=${encodeURIComponent(keyword)}&pg=${page}`;
      const data = await withTimeout(fetchJson(url), 8000);
      if (data?.code !== 1 && !Array.isArray(data?.list)) throw new Error('invalid cms response');
      const list = data.list ?? [];
      return list.map((it: any) => {
        const groups = parsePlayGroups(it.vod_play_url ?? '');
        const eps = groups[0] ?? [];
        return {
          id: String(it.vod_id),
          sourceId: cfg.id,
          sourceName: cfg.name,
          title: it.vod_name ?? '未知',
          cover: it.vod_pic,
          year: it.vod_year,
          mediaType: 'video' as const,
          playUrl: eps[0]?.url,
          episodes: eps,
          raw: { ...it, lineGroups: groups, lines: groups.length },
        } as MediaItem;
      });
    },

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      // 影视源播放地址已在搜索时解析进 episodes；此处支持按详情刷新
      const url = `${base}?ac=detail&ids=${encodeURIComponent(itemId)}`;
      const data = await fetchJson(url);
      const it = data?.list?.[0];
      const eps = parsePlayUrl(it?.vod_play_url ?? '');
      return { url: eps[0]?.url ?? '' };
    },

    async test(): Promise<boolean> {
      try {
        const data = await withTimeout(fetchJson(`${base}?ac=list&pg=1`), 6000);
        return data?.code === 1 || Array.isArray(data?.list);
      } catch {
        return false;
      }
    },
  };
}
