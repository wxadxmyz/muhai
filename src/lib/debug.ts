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

function emit() {
  for (const l of listeners) l();
}

export const debugLog = {
  get(): DebugEntry[] {
    return entries.slice().reverse();
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
