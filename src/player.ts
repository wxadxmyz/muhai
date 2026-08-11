// 播放解析：若 item 已带 playUrl 直接用，否则经对应源适配器取直链
import { createSource, MediaItem, SourceConfig } from './engine';

export async function resolvePlay(item: MediaItem, sources: SourceConfig[]): Promise<MediaItem> {
  if (item.playUrl) return item;
  const cfg = sources.find((s) => s.id === item.sourceId);
  if (!cfg) return item;
  try {
    const { url, headers } = await createSource(cfg).getPlayUrl(item.id);
    return { ...item, playUrl: url, raw: { ...item.raw, headers } };
  } catch {
    throw new Error('获取播放地址失败');
  }
}
