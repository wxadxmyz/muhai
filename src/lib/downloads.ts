import { useSyncExternalStore } from 'react';
import { MediaItem } from '../engine/types';
import { isTauri, downloadFile, notify } from './tauriBridge';

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
  const ext = (url.split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i)?.[1] || (item.mediaType === 'music' ? 'mp3' : 'mp4')).toLowerCase();
  const filename = `${item.title}.${ext}`;
  const id = item.id + url;

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
