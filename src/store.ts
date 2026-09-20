import { useCallback, useSyncExternalStore } from 'react';
import { createSource, SourceConfig, SourceType, uuid } from './engine';

const PREFIX = 'mps_sources_';

export interface SourceForm {
  name: string;
  type: SourceType;
  baseUrl: string;
  token?: string;
  mountPath?: string;
}

// 单例仓库：按 appKey 维护唯一内存态。所有 useSources(appKey) 调用共享同一实例，
// 任一处（导入页 / 源管理 / 主页）增删改都会触发全部消费者重新渲染，
// 根治"在导入页添加源后主页不刷新"的问题。持久化仍交给 localStorage。
type Listener = () => void;

interface StoreState {
  sources: SourceConfig[];
}

// 注意：按用户要求（v2.5.9）不再内置任何默认源。首次启动若 localStorage 为空则返回空列表，
// 由用户通过「导入 json 源 → 手动粘贴」自行导入（如量子单线路源）。

const stores = new Map<string, { state: StoreState; listeners: Set<Listener> }>();

function readPersisted(appKey: string): SourceConfig[] {
  try {
    const raw = localStorage.getItem(PREFIX + appKey);
    if (raw) {
      const list = JSON.parse(raw);
      // v2.4.2 起移除内置直连直播源（lives-direct / built-in://lives）。
      // 已装用户的旧 localStorage 里可能残留该源，这里读取时过滤掉，
      // 避免仓库管理页仍显示"幕海·内置直播"。
      return (Array.isArray(list) ? list : []).filter(
        (s: SourceConfig) => s.type !== 'lives-direct' && s.baseUrl !== 'built-in://lives'
      );
    }
  } catch {
    /* ignore */
  }
  // 无已存源：按用户要求不内置默认源，返回空列表，由用户手动导入。
  return [];
}

function getStore(appKey: string) {
  let s = stores.get(appKey);
  if (!s) {
    s = { state: { sources: readPersisted(appKey) }, listeners: new Set() };
    stores.set(appKey, s);
  }
  return s;
}

function persist(appKey: string, sources: SourceConfig[]) {
  try {
    localStorage.setItem(PREFIX + appKey, JSON.stringify(sources));
  } catch {
    /* ignore */
  }
}

function commit(appKey: string, next: SourceConfig[]) {
  const s = getStore(appKey);
  s.state = { sources: next };
  persist(appKey, next);
  s.listeners.forEach((l) => l());
}

export function useSources(appKey: string) {
  const store = getStore(appKey);

  const subscribe = useCallback(
    (cb: Listener) => {
      store.listeners.add(cb);
      return () => {
        store.listeners.delete(cb);
      };
    },
    [store]
  );

  const getSnapshot = useCallback(() => store.state, [store]);

  const state = useSyncExternalStore(subscribe, getSnapshot);
  const sources = state.sources;

  const add = useCallback(
    (form: SourceForm) => {
      const cur = getStore(appKey).state.sources;
      commit(appKey, [
        ...cur,
        {
          id: uuid(),
          name: form.name,
          type: form.type,
          baseUrl: form.baseUrl,
          token: form.token,
          enabled: true,
          priority: cur.length,
          extra: form.mountPath ? { mountPath: form.mountPath } : undefined,
        },
      ]);
    },
    [appKey]
  );

  const update = useCallback(
    (id: string, patch: Partial<SourceConfig>) => {
      const cur = getStore(appKey).state.sources;
      commit(appKey, cur.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    },
    [appKey]
  );

  const remove = useCallback(
    (id: string) => {
      const cur = getStore(appKey).state.sources;
      commit(appKey, cur.filter((x) => x.id !== id));
    },
    [appKey]
  );

  const toggle = useCallback(
    (id: string) => {
      const cur = getStore(appKey).state.sources;
      commit(appKey, cur.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x)));
    },
    [appKey]
  );

  const move = useCallback(
    (id: string, dir: -1 | 1) => {
      const cur = getStore(appKey).state.sources;
      const sorted = [...cur].sort((a, b) => a.priority - b.priority);
      const i = sorted.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= sorted.length) return;
      const pa = sorted[i].priority;
      sorted[i].priority = sorted[j].priority;
      sorted[j].priority = pa;
      commit(appKey, sorted);
    },
    [appKey]
  );

  const importSources = useCallback(
    (json: string): { added: number; skipped: number; errors: string[] } => {
      try {
        const arr = JSON.parse(json);
        if (!Array.isArray(arr)) return { added: 0, skipped: 0, errors: ['应为源数组 JSON'] };
        const valid = arr.filter((r: any) => r?.type && r?.baseUrl);
        const cur = getStore(appKey).state.sources;
        // 本次已导入的 + 仓库已有的，合并为去重基准。
        // 修复：导入 JSON（导出时必带 id）时，旧写法把 `...r` 放在 `id: uuid()` 之后，
        //   导致新源沿用旧 id → 与仓库里同 id 的行撞 React key → 只渲染出一行，看起来「加不进去」。
        //   现在强制用 uuid() 覆盖外部 id，并按 name+baseUrl 与现有源去重，避免堆重复行。
        const keyOf = (s: any) => `${String(s?.name ?? '').trim()}||${String(s?.baseUrl ?? '').trim()}`;
        const seen = new Set<string>(cur.map(keyOf));
        let skipped = 0;
        const incoming: SourceConfig[] = [];
        for (const r of valid as any[]) {
          const k = keyOf(r);
          if (seen.has(k)) { skipped++; continue; } // 已有同名同地址的源，跳过
          seen.add(k);
          incoming.push({
            ...r,
            id: uuid(),            // 强制新 id：不信任 JSON 里的 id（否则与现有行撞 key）
            enabled: r.enabled !== false,
            priority: cur.length + incoming.length,
          });
        }
        if (incoming.length) commit(appKey, [...cur, ...incoming]);
        const errors: string[] = [];
        if (arr.length - valid.length > 0) errors.push('已跳过无效条目');
        if (skipped > 0) errors.push(`已跳过 ${skipped} 个已存在的源`);
        return { added: incoming.length, skipped, errors };
      } catch (e: any) {
        return { added: 0, skipped: 0, errors: [e?.message ?? '解析失败'] };
      }
    },
    [appKey]
  );

  const exportSources = useCallback((): string => {
    return JSON.stringify(getStore(appKey).state.sources, null, 2);
  }, [appKey]);

  // 重置 APP：清空全部源（内存 + 持久化），回到无源状态
  const clearAll = useCallback(() => {
    commit(appKey, []);
  }, [appKey]);

  const test = useCallback(async (cfg: SourceConfig): Promise<boolean> => {
    try {
      return await createSource(cfg).test();
    } catch {
      return false;
    }
  }, []);

  return { sources, add, update, remove, toggle, move, importSources, exportSources, test, clearAll };
}
