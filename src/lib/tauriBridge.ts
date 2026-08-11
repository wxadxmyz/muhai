// P2 原生能力桥接层：在 Tauri 桌面端调用系统插件，在纯 Web 下优雅降级。
// 所有导出函数都会先判断是否运行于 Tauri，再决定走原生还是回退实现，
// 因此同一套前端代码在「网页原型 / Tauri 桌面端 / Tauri 安卓端」都不会崩。
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { enable as autostartEnable, disable as autostartDisable, isEnabled as autostartIsEnabled } from '@tauri-apps/plugin-autostart';
import { register as gsRegister } from '@tauri-apps/plugin-global-shortcut';
import { check as updaterCheck } from '@tauri-apps/plugin-updater';
import { getCurrentWindow } from '@tauri-apps/api/window';

declare const window: any;

/** 是否运行在 Tauri 运行时内（区分网页原型与打包应用） */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export type DownloadResult = { ok: boolean; path?: string; error?: string };

/**
 * 下载并保存到磁盘。Tauri 端走系统对话框选路径 + 文件系统写入（真实落盘）；
 * 网页端用浏览器原生下载（仅同源/可跨域资源可用）。
 */
export async function downloadFile(
  filename: string,
  url: string,
  onProgress?: (pct: number) => void,
): Promise<DownloadResult> {
  if (isTauri()) {
    try {
      const path = await save({ defaultPath: filename });
      if (!path) return { ok: false, error: '已取消' };
      onProgress?.(10);
      const res = await fetch(url);
      if (!res.ok) return { ok: false, error: `下载失败 HTTP ${res.status}` };
      const buf = new Uint8Array(await res.arrayBuffer());
      onProgress?.(70);
      await writeFile(path, buf);
      onProgress?.(100);
      return { ok: true, path };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  }
  // Web 回退
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    onProgress?.(100);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * 保存二进制数据（Blob）到磁盘。Tauri 端走系统对话框选路径 + 文件系统写入（真实落盘）；
 * 网页端用 object URL 触发浏览器下载。用于截图等本地生成的二进制内容。
 */
export async function saveBlob(blob: Blob, filename: string): Promise<DownloadResult> {
  if (isTauri()) {
    try {
      const path = await save({ defaultPath: filename });
      if (!path) return { ok: false, error: '已取消' };
      const buf = new Uint8Array(await blob.arrayBuffer());
      await writeFile(path, buf);
      return { ok: true, path };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  }
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** 系统通知。Tauri 端走原生通知（可带权限申请）；网页端用 Web Notification。 */
export async function notify(title: string, body?: string): Promise<boolean> {
  if (isTauri()) {
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = await requestPermission() === 'granted';
      if (!granted) return false;
      sendNotification({ title, body });
      return true;
    } catch {
      return false;
    }
  }
  try {
    if ('Notification' in window) {
      new Notification(title, { body });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** 开机自启。仅在 Tauri 桌面端有效，网页端返回 false。 */
export async function setAutostart(enabled: boolean): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    if (enabled) await autostartEnable();
    else await autostartDisable();
    return await autostartIsEnabled();
  } catch {
    return false;
  }
}
export async function getAutostart(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await autostartIsEnabled();
  } catch {
    return false;
  }
}

/** 注册全局快捷键（窗口失焦也生效）。仅 Tauri 桌面端有效。 */
export async function registerGlobalShortcuts(handlers: {
  toggle?: () => void;
  next?: () => void;
  prev?: () => void;
}): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const map: Record<string, () => void> = {
      MediaPlayPause: handlers.toggle ?? (() => {}),
      MediaTrackNext: handlers.next ?? (() => {}),
      MediaTrackPrevious: handlers.prev ?? (() => {}),
    };
    for (const [accel, fn] of Object.entries(map)) {
      try {
        await gsRegister(accel, fn);
      } catch {
        /* 该快捷键/平台不支持则跳过 */
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** 最小化到托盘（隐藏窗口）。仅 Tauri 桌面端有效。 */
export async function minimizeToTray(): Promise<void> {
  if (!isTauri()) return;
  try {
    await getCurrentWindow().hide();
  } catch {
    /* ignore */
  }
}

export type UpdateCheck =
  | { available: false }
  | { available: true; version: string; notes?: string; updated: boolean; error?: string };

/** 检查并安装更新（侧载分发强烈建议）。仅 Tauri 桌面端有效。 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!isTauri()) return { available: false };
  try {
    const update = await updaterCheck();
    if (!update) return { available: false };
    // downloadAndInstall 在 Rust 侧安装完成后会自动重启应用（v2 已内置 relaunch）
    await update.downloadAndInstall();
    return { available: true, version: update.version, notes: update.body ?? undefined, updated: true };
  } catch (e: any) {
    return { available: true, version: '', notes: undefined, updated: false, error: String(e?.message || e) };
  }
}
