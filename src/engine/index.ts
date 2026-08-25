// 引擎入口：工厂 + 跨源搜索聚合 + 源管理器
import { createMusicJsonSource } from './adapters/musicJson';
import { createAlistSource } from './adapters/alist';
import { createMockSource } from './adapters/mock';
import { createTvboxSource, expandTvboxSpiders } from './adapters/tvbox';
import { createJsSource } from './adapters/js';
import { createNormalSource } from './adapters/normal';
import { withTimeout } from './http';
import { LiveChannelSource, MediaItem, MediaSource, SourceConfig, MediaType } from './types';

export * from './types';

export function createSource(cfg: SourceConfig): MediaSource {
  switch (cfg.type) {
    case 'music-json':
      return createMusicJsonSource(cfg);
    case 'alist':
      return createAlistSource(cfg);
    case 'tvbox':
      return createTvboxSource(cfg);
    case 'js':
      return createJsSource(cfg);
    case 'normal':
      return createNormalSource(cfg);
    case 'mock':
      return createMockSource(cfg);
    default:
      throw new Error(`未知源类型: ${(cfg as any).type}`);
  }
}

// 把 tvbox 配置展开为子站列表（供搜索页左侧源栏等使用）。
// 非 tvbox 源原样返回；limit 用于限制子站数量（首页聚合等场景）。
export async function expandSources(
  sources: SourceConfig[],
  opts: { limit?: number } = {}
): Promise<SourceConfig[]> {
  const active = sources.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);
  const out: SourceConfig[] = [];
  for (const s of active) {
    if (s.type === 'tvbox') {
      try {
        const subs = await expandTvboxSpiders(s);
        out.push(...(opts.limit ? subs.slice(0, opts.limit) : subs));
      } catch {
        out.push(s); // 展开失败回退为配置本身
      }
    } else {
      out.push(s);
    }
  }
  return out;
}

// 跨源搜索：并发请求所有启用源，按优先级合并
export async function aggregateSearch(
  sources: SourceConfig[],
  keyword: string,
  opts: { timeout?: number; mediaType?: MediaType } = {}
): Promise<{ items: MediaItem[]; errors: { sourceId: string; sourceName: string; message: string }[] }> {
  const active = sources
    .filter((s) => s.enabled)
    .sort((a, b) => a.priority - b.priority);

  const results = await Promise.all(
    active.map(async (s) => {
      try {
        const items = await withTimeout(createSource(s).search(keyword, 1), opts.timeout ?? 30000);
        return { ok: true as const, sourceId: s.id, items };
      } catch (e: any) {
        return { ok: false as const, sourceId: s.id, sourceName: s.name, message: e?.message ?? '搜索失败' };
      }
    })
  );

  let items = results.flatMap((r) => (r.ok ? r.items : []));
  if (opts.mediaType) items = items.filter((it) => it.mediaType === opts.mediaType);
  const errors = results
    .filter((r) => !r.ok)
    .map((r) => ({
      sourceId: (r as any).sourceId,
      sourceName: (r as any).sourceName ?? (r as any).sourceId,
      message: (r as any).message,
    }));

  // 同名同艺术家去重，保留多源备选
  const map = new Map<string, MediaItem>();
  for (const it of items) {
    const key = `${it.title}|${it.artist ?? ''}`;
    if (!map.has(key)) map.set(key, it);
  }
  return { items: Array.from(map.values()), errors };
}

// 首页聚合：并发拉取所有启用源的首页推荐，合并去重。
// tvbox 配置先展开为子站，每配置最多取前 limit 个子站（默认 8），避免全量子站超时。
export async function aggregateHome(
  sources: SourceConfig[],
  opts: { timeout?: number; limit?: number } = {}
): Promise<{ items: MediaItem[]; errors: { sourceId: string; sourceName: string; message: string }[] }> {
  const active = sources.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);
  const expanded = await expandSources(active, { limit: opts.limit ?? 8 });
  const results = await Promise.all(
    expanded.map(async (s) => {
      try {
        const src = createSource(s);
        if (!src.home) return { ok: false as const, sourceId: (s as any).parentId ?? s.id, sourceName: s.name, message: '该源不支持首页' };
        const items = await withTimeout(src.home(), opts.timeout ?? 30000);
        return { ok: true as const, sourceId: (s as any).parentId ?? s.id, sourceName: s.name, items };
      } catch (e: any) {
        return { ok: false as const, sourceId: (s as any).parentId ?? s.id, sourceName: s.name, message: e?.message ?? '首页加载失败' };
      }
    })
  );
  const items = results.flatMap((r) => (r.ok ? r.items : []));
  const errors = results.filter((r) => !r.ok).map((r) => ({
    sourceId: (r as any).sourceId,
    sourceName: (r as any).sourceName ?? (r as any).sourceId,
    message: (r as any).message,
  }));
  const map = new Map<string, MediaItem>();
  for (const it of items) {
    const key = `${it.title}|${it.artist ?? ''}`;
    if (!map.has(key)) map.set(key, it);
  }
  return { items: Array.from(map.values()), errors };
}

// 直播源聚合：收集所有启用 tvbox 源的 lives[]
// 问题 #3 修复：直播源聚合结果模块级缓存，避免 Live 组件每次 mount 重复拉取
// （切 Tab 出去再回来会重新挂载，无缓存则又要等几秒才出源列表）。
// key 用"生效 tvbox 源 id 升序拼接"，源变化即失效。
let _livesCache: { key: string; data: { groups: any[]; errors: string[] } } | null = null;
function livesCacheKey(sources: SourceConfig[]): string {
  return sources
    .filter((s) => s.enabled && s.type === 'tvbox')
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.id)
    .join('|');
}

export async function aggregateLives(
  sources: SourceConfig[],
  opts: { force?: boolean } = {}
): Promise<{ groups: { sourceId: string; sourceName: string; channels: LiveChannelSource[] }[]; errors: string[] }> {
  const key = livesCacheKey(sources);
  if (!opts.force && _livesCache && _livesCache.key === key) {
    return _livesCache.data as any;
  }
  const active = sources.filter((s) => s.enabled && s.type === 'tvbox').sort((a, b) => a.priority - b.priority);
  const groups: { sourceId: string; sourceName: string; channels: LiveChannelSource[] }[] = [];
  const errors: string[] = [];
  await Promise.all(
    active.map(async (s) => {
      try {
        const src = createSource(s);
        if (!src.lives) return;
        const channels = await src.lives();
        if (channels.length) groups.push({ sourceId: s.id, sourceName: s.name, channels });
      } catch (e: any) {
        errors.push(`${s.name}：${e?.message ?? '直播源加载失败'}`);
      }
    })
  );
  const data = { groups, errors };
  _livesCache = { key, data };
  return data;
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
