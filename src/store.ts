import { useCallback, useEffect, useState } from 'react';
import { createSource, SourceConfig, SourceType, uuid } from './engine';

const PREFIX = 'mps_sources_';

export interface SourceForm {
  name: string;
  type: SourceType;
  baseUrl: string;
  token?: string;
  mountPath?: string;
}

function load(appKey: string): SourceConfig[] {
  try {
    const raw = localStorage.getItem(PREFIX + appKey);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  // 无默认源：首次运行为干净的空态，由用户自行导入真实源
  return [];
}

export function useSources(appKey: string) {
  const [sources, setSources] = useState<SourceConfig[]>(() => load(appKey));

  useEffect(() => {
    localStorage.setItem(PREFIX + appKey, JSON.stringify(sources));
  }, [sources, appKey]);

  const add = useCallback((form: SourceForm) => {
    setSources((s) => [
      ...s,
      {
        id: uuid(),
        name: form.name,
        type: form.type,
        baseUrl: form.baseUrl,
        token: form.token,
        enabled: true,
        priority: s.length,
        extra: form.mountPath ? { mountPath: form.mountPath } : undefined,
      },
    ]);
  }, []);

  const update = useCallback((id: string, patch: Partial<SourceConfig>) => {
    setSources((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, []);

  const remove = useCallback((id: string) => {
    setSources((s) => s.filter((x) => x.id !== id));
  }, []);

  const toggle = useCallback((id: string) => {
    setSources((s) => s.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x)));
  }, []);

  const move = useCallback((id: string, dir: -1 | 1) => {
    setSources((s) => {
      const sorted = [...s].sort((a, b) => a.priority - b.priority);
      const i = sorted.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= sorted.length) return s;
      const pa = sorted[i].priority;
      sorted[i].priority = sorted[j].priority;
      sorted[j].priority = pa;
      return sorted;
    });
  }, []);

  const importSources = useCallback((json: string): { added: number; errors: string[] } => {
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) return { added: 0, errors: ['应为源数组 JSON'] };
      const valid = arr.filter((r: any) => r?.type && r?.baseUrl);
      setSources((s) => [
        ...s,
        ...valid.map((r: any) => ({ id: uuid(), enabled: true, priority: s.length, ...r })),
      ]);
      const errors = arr.length - valid.length > 0 ? ['已跳过无效条目'] : [];
      return { added: valid.length, errors };
    } catch (e: any) {
      return { added: 0, errors: [e?.message ?? '解析失败'] };
    }
  }, []);

  const exportSources = useCallback((): string => {
    return JSON.stringify(sources, null, 2);
  }, [sources]);

  const test = useCallback(async (cfg: SourceConfig): Promise<boolean> => {
    try {
      return await createSource(cfg).test();
    } catch {
      return false;
    }
  }, []);

  return { sources, add, update, remove, toggle, move, importSources, exportSources, test };
}
