// 引擎入口：工厂 + 跨源搜索聚合 + 源管理器
import { createMusicJsonSource } from './adapters/musicJson';
import { createVideoCmsSource } from './adapters/videoCms';
import { createAlistSource } from './adapters/alist';
import { createMockSource } from './adapters/mock';
import { createTvboxSource } from './adapters/tvbox';
import { withTimeout } from './http';
import { MediaItem, MediaSource, SourceConfig, MediaType } from './types';

export * from './types';

export function createSource(cfg: SourceConfig): MediaSource {
  switch (cfg.type) {
    case 'music-json':
      return createMusicJsonSource(cfg);
    case 'video-cms':
      return createVideoCmsSource(cfg);
    case 'alist':
      return createAlistSource(cfg);
    case 'tvbox':
      return createTvboxSource(cfg);
    case 'mock':
      return createMockSource(cfg);
    default:
      throw new Error(`未知源类型: ${(cfg as any).type}`);
  }
}

// 跨源搜索：并发请求所有启用源，按优先级合并
export async function aggregateSearch(
  sources: SourceConfig[],
  keyword: string,
  opts: { timeout?: number; mediaType?: MediaType } = {}
): Promise<{ items: MediaItem[]; errors: { sourceId: string; message: string }[] }> {
  const active = sources
    .filter((s) => s.enabled)
    .sort((a, b) => a.priority - b.priority);

  const results = await Promise.all(
    active.map(async (s) => {
      try {
        const items = await withTimeout(createSource(s).search(keyword, 1), opts.timeout ?? 8000);
        return { ok: true as const, sourceId: s.id, items };
      } catch (e: any) {
        return { ok: false as const, sourceId: s.id, message: e?.message ?? '搜索失败' };
      }
    })
  );

  let items = results.flatMap((r) => (r.ok ? r.items : []));
  if (opts.mediaType) items = items.filter((it) => it.mediaType === opts.mediaType);
  const errors = results
    .filter((r) => !r.ok)
    .map((r) => ({ sourceId: (r as any).sourceId, message: (r as any).message }));

  // 同名同艺术家去重，保留多源备选
  const map = new Map<string, MediaItem>();
  for (const it of items) {
    const key = `${it.title}|${it.artist ?? ''}`;
    if (!map.has(key)) map.set(key, it);
  }
  return { items: Array.from(map.values()), errors };
}

// 源管理器：内存态，持久化由上层（localStorage / 文件）负责
export class SourceManager {
  private list: SourceConfig[] = [];

  setAll(list: SourceConfig[]) {
    this.list = [...list];
  }
  getAll(): SourceConfig[] {
    return [...this.list].sort((a, b) => a.priority - b.priority);
  }
  get(id: string): SourceConfig | undefined {
    return this.list.find((s) => s.id === id);
  }
  add(cfg: SourceConfig): void {
    this.list.push(cfg);
  }
  update(id: string, patch: Partial<SourceConfig>): void {
    const i = this.list.findIndex((s) => s.id === id);
    if (i >= 0) this.list[i] = { ...this.list[i], ...patch };
  }
  remove(id: string): void {
    this.list = this.list.filter((s) => s.id !== id);
  }
  toggle(id: string): void {
    const s = this.get(id);
    if (s) s.enabled = !s.enabled;
  }
  move(id: string, dir: -1 | 1): void {
    const sorted = this.getAll();
    const i = sorted.findIndex((s) => s.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= sorted.length) return;
    const a = sorted[i], b = sorted[j];
    const pa = a.priority;
    a.priority = b.priority;
    b.priority = pa;
  }

  async test(id: string): Promise<boolean> {
    const s = this.get(id);
    if (!s) return false;
    return createSource(s).test();
  }

  export(): string {
    return JSON.stringify(this.getAll(), null, 2);
  }
  import(json: string): { added: number; errors: string[] } {
    const errors: string[] = [];
    let added = 0;
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) throw new Error('应为源数组');
      for (const raw of arr) {
        if (!raw?.type || !raw?.baseUrl) {
          errors.push(`跳过无效源: ${JSON.stringify(raw).slice(0, 60)}`);
          continue;
        }
        this.add({ enabled: true, priority: this.list.length + 1, name: '导入源', ...raw });
        added++;
      }
    } catch (e: any) {
      errors.push(e?.message ?? '解析失败');
    }
    return { added, errors };
  }
}
