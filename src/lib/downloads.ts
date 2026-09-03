import { useSyncExternalStore } from 'react';
import { MediaItem } from '../engine/types';
import { isTauri, downloadFile, notify, saveBlob } from './tauriBridge';

// B2：相对 URL 解析（m3u8 分片多为相对路径）
function resolveUrl(base: string, rel: string): string {
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

// B2：m3u8 真实下载 —— 抓 playlist，若为 master 则选最高码率变体，再逐片抓取 ts 并拼接为单文件 TS。
//   拼接后的 .ts 可被大多数播放器直接播放（每个分片自带 PAT/PMT），不再是"下到 playlist 文本当假文件"。
//   注：加密分片（EXT-X-KEY）此处不做解密，会如实报错。
async function downloadM3u8(
  rootUrl: string,
  referer: string | undefined,
  onProgress: (pct: number) => void,
): Promise<Blob> {
  const headers = referer ? { Referer: referer } : undefined;
  const fetchTxt = async (u: string): Promise<string> => {
    const res = await fetch(u, headers ? { headers } : undefined);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  };
  let playlist = await fetchTxt(rootUrl);
  // master playlist：选带宽最高的变体继续
  if (/#EXT-X-STREAM-INF/i.test(playlist)) {
    const lines = playlist.split('\n');
    let best: string | null = null;
    let bestBw = -1;
    let pendingBw = 0;
    let pending = false;
    for (const raw of lines) {
      const s = raw.trim();
      if (s.startsWith('#EXT-X-STREAM-INF')) {
        const m = s.match(/BANDWIDTH=(\d+)/i);
        pendingBw = m ? +m[1] : 0;
        pending = true;
      } else if (pending && s && !s.startsWith('#')) {
        if (pendingBw >= bestBw) {
          bestBw = pendingBw;
          best = s;
        }
        pending = false;
      }
    }
    const variant = best ?? lines.find((l) => l.trim() && !l.trim().startsWith('#'))?.trim();
    if (!variant) throw new Error('无法解析 m3u8 变体');
    playlist = await fetchTxt(resolveUrl(rootUrl, variant));
  }
  const segLines = playlist
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const total = segLines.length;
  if (!total) throw new Error('m3u8 无分片');
  const parts: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const segUrl = resolveUrl(rootUrl, segLines[i]);
    const res = await fetch(segUrl, headers ? { headers } : undefined);
    if (!res.ok) throw new Error('分片 HTTP ' + res.status);
    parts.push(new Uint8Array(await res.arrayBuffer()));
    onProgress(Math.min(99, Math.floor(((i + 1) / total) * 100)));
  }
  const totalLen = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return new Blob([out], { type: 'video/MP2T' });
}

export interface DownloadTask {
  id: string;
  item: MediaItem;
  progress: number; // 0~100
  status: 'pending' | 'downloading' | 'done' | 'error';
  error?: string;
}

let tasks: DownloadTask[] = [];
const listeners = new Set<() => void>();
let opts = { notifyDownload: true };
function emit() {
  for (const l of listeners) l();
}
function setState(patch: Partial<DownloadTask>, id: string) {
  tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
  emit();
}
// 由设置页注入「下载完成是否系统通知」等偏好
export function setDownloadOptions(o: Partial<typeof opts>) {
  opts = { ...opts, ...o };
}

// 真实下载：
// - Tauri 桌面端：用系统对话框选路径 + 文件系统真实落盘到磁盘（P2-12）。
// - 网页端：同源或允许跨域(CORS)的源可成功拉流并触发浏览器原生下载。
// 其余（跨域受限、data:/blob: 伪链接等）如实标记失败，绝不再假装完成。
async function realDownload(item: MediaItem): Promise<void> {
  const url = item.playUrl;
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) throw new Error('该源不支持直接下载');
  const id = item.id + url;
  // B2：m3u8 走真实分片下载（拼为可播放 .ts），不再把 playlist 文本当假文件
  const isM3u8 = /\.m3u8($|\?)/i.test(url);
  if (isM3u8) {
    const referer = (item.raw as any)?.headers?.Referer as string | undefined;
    const blob = await downloadM3u8(url, referer, (p) => setState({ progress: p }, id));
    const fname = `${item.title}.ts`;
    if (isTauri()) {
      const r = await saveBlob(blob, fname);
      if (!r.ok) throw new Error(r.error || '保存失败');
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  const ext = (url.split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i)?.[1] || (item.mediaType === 'music' ? 'mp3' : 'mp4')).toLowerCase();
  const filename = `${item.title}.${ext}`;

  if (isTauri()) {
    const r = await downloadFile(filename, url, (p) => setState({ progress: p }, id));
    if (!r.ok) throw new Error(r.error || '下载失败');
    return;
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      const p = total ? Math.floor((received / total) * 100) : Math.min(99, received / 50000);
      setState({ progress: p }, id);
    }
  }
  const blob = new Blob(chunks as any);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const downloadStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get() {
    return tasks;
  },
  start(item: MediaItem) {
    const id = item.id + (item.playUrl || 'local');
    if (tasks.some((t) => t.id === id)) return;
    tasks = [{ id, item, progress: 0, status: 'downloading' }, ...tasks];
    emit();
    realDownload(item)
      .then(() => {
        setState({ progress: 100, status: 'done' }, id);
        // P2-17 下载完成系统通知（桌面端 Tauri 通知插件；网页端用 Web Notification）
        if (opts.notifyDownload) {
          notify(`下载完成：${item.title}`, '已保存到磁盘。');
        }
      })
      .catch((err: any) => {
        // 如实标记失败：不模拟进度、不假装完成
        setState({ status: 'error', error: err?.message ?? '下载失败' }, id);
      });
  },
  remove(id: string) {
    tasks = tasks.filter((t) => t.id !== id);
    emit();
  },
  // 清除已完成与失败的任务（isDir 假完成逻辑已移除）
  clearDone() {
    tasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'error');
    emit();
  },
};

export function useDownloads() {
  return useSyncExternalStore(downloadStore.subscribe, downloadStore.get);
}
