import { SourceConfig } from '../engine/types';
import { debugLog } from './debug';

export interface AlistFile {
  name: string;
  isDir: boolean;
  size?: number;
  path: string;
  thumb?: string;
}

const VIDEO_EXT = /\.(mp4|mkv|webm|m3u8|avi|mov|flv)$/i;

// 演示用文件树（当音源为 mock 或无真实 alist 地址时回退，保证开箱可用）
function mockTree(path: string): AlistFile[] {
  if (path === '/') {
    return [
      { name: '电影', isDir: true, path: '/电影' },
      { name: '电视剧', isDir: true, path: '/电视剧' },
      { name: '动漫', isDir: true, path: '/动漫' },
      { name: '学习资料', isDir: true, path: '/学习资料' },
    ];
  }
  if (path === '/电影') {
    return [
      { name: '星际穿越 (2014).mkv', isDir: false, size: 3_200_000_000, path: '/电影/星际穿越 (2014).mkv' },
      { name: '盗梦空间 (2010).mp4', isDir: false, size: 2_100_000_000, path: '/电影/盗梦空间 (2010).mp4' },
      { name: '科幻合集', isDir: true, path: '/电影/科幻合集' },
    ];
  }
  if (path === '/电视剧') {
    return [
      { name: '权力的游戏', isDir: true, path: '/电视剧/权力的游戏' },
      { name: '怪奇物语', isDir: true, path: '/电视剧/怪奇物语' },
    ];
  }
  if (path === '/动漫') {
    return [
      { name: '你的名字.mp4', isDir: false, size: 1_400_000_000, path: '/动漫/你的名字.mp4' },
      { name: '千与千寻.mkv', isDir: false, size: 1_100_000_000, path: '/动漫/千与千寻.mkv' },
    ];
  }
  return [];
}

async function alistList(cfg: SourceConfig, path: string): Promise<AlistFile[]> {
  if (!cfg.baseUrl) return mockTree(path);
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/fs/list`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.token ? { Authorization: cfg.token } : {}),
      },
      body: JSON.stringify({ path, password: '', page: 1, per_page: 100 }),
    });
    debugLog.record({ method: 'POST', url, status: res.status, ok: res.ok, durationMs: Date.now() - t0 });
    if (!res.ok) return mockTree(path);
    const data = await res.json();
    const content = data?.data?.content || [];
    return content.map((f: any) => ({
      name: f.name,
      isDir: !!f.is_dir,
      size: f.size,
      path: f.path || path + '/' + f.name,
      thumb: f.thumb,
    }));
  } catch (e: any) {
    debugLog.record({ method: 'POST', url, ok: false, durationMs: Date.now() - t0, error: e?.message });
    return mockTree(path);
  }
}

// 取网盘内视频的播放直链（alist /api/fs/get）
async function alistGetUrl(cfg: SourceConfig, path: string): Promise<string | null> {
  if (!cfg.baseUrl) {
    // 演示：返回一个示例 m3u8 直链
    return 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  }
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/fs/get`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.token ? { Authorization: cfg.token } : {}),
      },
      body: JSON.stringify({ path }),
    });
    debugLog.record({ method: 'POST', url, status: res.status, ok: res.ok, durationMs: Date.now() - t0 });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.raw_url || data?.data?.url || null;
  } catch (e: any) {
    debugLog.record({ method: 'POST', url, ok: false, durationMs: Date.now() - t0, error: e?.message });
    return null;
  }
}

// 云同步结果
export interface SyncResult {
  ok: boolean;
  where: 'cloud' | 'none';
  message: string;
  data?: string; // restore 成功时返回配置串
}

// 云同步备份：仅当配置了真实 alist 时才写入网盘；未配置则明确「未启用」，绝不假同步。
// alist 上传接口：PUT /api/fs/put?path=<完整文件路径>，请求体为文件原始内容。
async function cloudBackup(cfg: SourceConfig | null, payload: string): Promise<SyncResult> {
  if (!cfg?.baseUrl) {
    return { ok: false, where: 'none', message: '未配置 alist 源，云同步未启用（请在「音源管理」添加一个 alist 源）。' };
  }
  const base = cfg.baseUrl.replace(/\/$/, '');
  const url = `${base}/api/fs/put?path=${encodeURIComponent('/mps_backup.json')}`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(cfg.token ? { Authorization: cfg.token } : {}),
      },
      body: payload,
    });
    if (!res.ok) return { ok: false, where: 'none', message: `云盘写入失败：HTTP ${res.status}` };
    return { ok: true, where: 'cloud', message: `已备份到云盘（${cfg.name}）。` };
  } catch (e: any) {
    return { ok: false, where: 'none', message: `云盘写入失败：${e?.message ?? '网络错误'}` };
  }
}

// 云同步恢复：取回网盘中的 /mps_backup.json 直链并下载内容。
async function cloudRestore(cfg: SourceConfig | null): Promise<SyncResult> {
  if (!cfg?.baseUrl) {
    return { ok: false, where: 'none', message: '未配置 alist 源，云同步未启用（请在「音源管理」添加一个 alist 源）。' };
  }
  const base = cfg.baseUrl.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/fs/get`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.token ? { Authorization: cfg.token } : {}),
      },
      body: JSON.stringify({ path: '/mps_backup.json' }),
    });
    if (!res.ok) return { ok: false, where: 'none', message: `云盘读取失败：HTTP ${res.status}` };
    const data = await res.json();
    const rawUrl = data?.data?.raw_url || data?.data?.url;
    if (!rawUrl) return { ok: false, where: 'none', message: '云盘中未找到备份文件（/mps_backup.json）。' };
    const text = await fetch(rawUrl).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    if (text == null) return { ok: false, where: 'none', message: '读取备份内容失败（直链不可达或被防盗链拦截）。' };
    return { ok: true, where: 'cloud', message: `已从云盘恢复（${cfg.name}）。`, data: text };
  } catch (e: any) {
    return { ok: false, where: 'none', message: `云盘读取失败：${e?.message ?? '网络错误'}` };
  }
}

export const alistClient = { VIDEO_EXT, list: alistList, getUrl: alistGetUrl, backup: cloudBackup, restore: cloudRestore };
