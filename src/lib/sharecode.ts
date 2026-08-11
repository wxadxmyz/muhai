import { SourceConfig, SourceType, uuid } from '../engine';

// 音源分享码：把音源配置编成一段可复制/粘贴的字符串，便于社区分享（仓库不内置具体源）
// 格式：MPS1.<base64url(json)>

function b64urlEncode(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): string {
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  const b = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return decodeURIComponent(escape(atob(b)));
}

export function encodeSources(sources: SourceConfig[]): string {
  const payload = sources.map((s) => ({
    n: s.name,
    t: s.type,
    u: s.baseUrl,
    k: s.token,
    p: s.extra?.mountPath,
  }));
  return 'MPS1.' + b64urlEncode(JSON.stringify(payload));
}

export function decodeSources(code: string): SourceConfig[] {
  const body = code.trim().replace(/^MPS1\./, '');
  const arr = JSON.parse(b64urlDecode(body));
  if (!Array.isArray(arr)) throw new Error('分享码格式不正确');
  return arr
    .filter((r: any) => r && r.t && r.u)
    .map((r: any) => ({
      id: uuid(),
      name: r.n || '导入音源',
      type: r.t as SourceType,
      baseUrl: r.u,
      token: r.k,
      enabled: true,
      priority: 0,
      extra: r.p ? { mountPath: r.p } : undefined,
    }));
}

export function isValidShareCode(code: string): boolean {
  return code.trim().startsWith('MPS1.');
}
