// 播放解析：若 item 已带 playUrl 直接用，否则经对应源适配器取直链
import { createSource, findSourceConfig, MediaItem, SourceConfig } from './engine';

export async function resolvePlay(item: MediaItem, sources: SourceConfig[]): Promise<MediaItem> {
  if (item.playUrl) return item;
  // V3.9.0：兼容 tvbox 子站 ID（s_xxx::drpy_yyy）→ 回退父级配置。
  const cfg = findSourceConfig(sources, item.sourceId);
  // V3.8.9 #C1：源缺失必须显式报错，禁止静默返回。
  // 旧实现 `return item` 会带着空 playUrl 一路返回，最终在播放器里落成一句
  // 「未取到可播放地址，换个线路或换个源试试」—— 这句完全看不出是「源找不到」，
  // 排查时只能靠猜。这里把 sourceId 与当前源列表规模一并报出，真机一次就能定位。
  if (!cfg) {
    throw new Error(
      `找不到源配置（sourceId=${item.sourceId || '(空)'}，当前共 ${sources.length} 个源）。` +
        '常见原因：该条目来自已删除/已禁用的源，或来自展开出的子站而源列表里只有父级配置。'
    );
  }
  try {
    const { url, headers } = await createSource(cfg).getPlayUrl(item.id);
    return { ...item, playUrl: url, raw: { ...item.raw, headers } };
  } catch (e: any) {
    // V3.7.1：保留底层真实错误（如 B1 的"网页不可播"、源站 404、超时），
    // 避免上游再显示一句模糊的"获取播放地址失败"。
    throw new Error(e?.message || '获取播放地址失败');
  }
}
