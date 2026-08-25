// 引擎请求调试日志缓冲：供「开发者调试面板」展示每次请求/响应/耗时
export interface DebugEntry {
  id: number;
  ts: number;
  method: string;
  url: string;
  status?: number;
  ok: boolean;
  durationMs: number;
  error?: string;
  preview?: string; // 响应预览（截断）
}

let entries: DebugEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();

// 缓存「倒序快照」：entries 不变时返回同一个引用，避免 useSyncExternalStore
// 因每次 getSnapshot 返回新数组而触发 invariant #185（Minified React error #185）。
let cachedSnapshot: DebugEntry[] | null = null;

function emit() {
  // entries 已变更，旧快照失效
  cachedSnapshot = null;
  for (const l of listeners) l();
}

export const debugLog = {
  // 返回稳定引用：仅在 entries 实际变化时重新生成倒序数组
  get(): DebugEntry[] {
    if (cachedSnapshot === null) cachedSnapshot = entries.slice().reverse();
    return cachedSnapshot;
  },
  record(e: Omit<DebugEntry, 'id' | 'ts'>): DebugEntry {
    const full: DebugEntry = { ...e, id: ++seq, ts: Date.now() };
    entries = [...entries, full].slice(-200);
    emit();
    return full;
  },
  clear() {
    entries = [];
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
