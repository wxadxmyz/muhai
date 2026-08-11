import { debugLog } from '../lib/debug';

// 轻量 HTTP 工具：带超时、JSON 解析，并写入调试日志缓冲
export async function fetchJson(
  url: string,
  opts: { method?: string; body?: any; headers?: Record<string, string>; timeout?: number } = {}
): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout ?? 8000);
  const t0 = Date.now();
  const method = opts.method ?? 'GET';
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    debugLog.record({
      method,
      url,
      status: res.status,
      ok: res.ok,
      durationMs: Date.now() - t0,
      preview: text.slice(0, 400),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (e: any) {
    debugLog.record({
      method,
      url,
      ok: false,
      durationMs: Date.now() - t0,
      error: e?.message ?? 'error',
    });
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export function withTimeout<T>(p: Promise<T>, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}
