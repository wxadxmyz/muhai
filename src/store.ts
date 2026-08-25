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
    (json: string): { added: number; errors: string[] } => {
      try {
        const arr = JSON.parse(json);
        if (!Array.isArray(arr)) return { added: 0, errors: ['应为源数组 JSON'] };
        const valid = arr.filter((r: any) => r?.type && r?.baseUrl);
        const cur = getStore(appKey).state.sources;
        commit(appKey, [
          ...cur,
          ...valid.map((r: any) => ({ id: uuid(), enabled: true, priority: cur.length, ...r })),
        ]);
        const errors = arr.length - valid.length > 0 ? ['已跳过无效条目'] : [];
        return { added: valid.length, errors };
      } catch (e: any) {
        return { added: 0, errors: [e?.message ?? '解析失败'] };
      }
    },
    [appKey]
  );

  const exportSources = useCallback((): string => {
    return JSON.stringify(getStore(appKey).state.sources, null, 2);
  }, [appKey]);

  const test = useCallback(async (cfg: SourceConfig): Promise<boolean> => {
    try {
      return await createSource(cfg).test();
    } catch {
      return false;
    }
  }, []);

  return { sources, add, update, remove, toggle, move, importSources, exportSources, test };
}
