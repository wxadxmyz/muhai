// C3 登录执行器：调用 Rust 命令 open_netdisk_login 打开官网登录窗口，
// 前端再把抓取脚本 eval 注入子窗口（window.__TAURI__.event.emit 全局可用），
// 登录成功后监听 'netdisk-captured' 事件拿到 token，再调用 close_netdisk_login 关窗。
// 注：Rust 侧不再用 initialization_script（该 API 在 Android target 编译不过），
// 改由前端注入以保证 Android 兼容。依赖 @tauri-apps/api（App 运行在 Tauri 内）。
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Webview } from '@tauri-apps/api/webview';
import { buildCaptureScript, setNetdiskToken, type NetdiskProvider } from './netdisk';

const TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟超时

/**
 * 打开官网登录页，登录成功后自动捕获 token 并存入已挂载列表。
 * @returns Promise<token|null> 捕获到的 token（超时/失败返回 null）
 */
export function openNetdiskLogin(p: NetdiskProvider): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (token: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        invoke('close_netdisk_login');
      } catch {
        /* ignore */
      }
      try {
        unlistenFn?.();
      } catch {
        /* ignore */
      }
      resolve(token);
    };

    const onEvent = (e: { payload?: { provider?: string; token?: string } }) => {
      const pl = e?.payload;
      if (pl && pl.provider === p.key && pl.token) {
        setNetdiskToken(p.key, pl.token);
        finish(pl.token);
      }
    };
    let unlistenFn: UnlistenFn | null = null;
    try {
      listen('netdisk-captured', onEvent as any).then((u) => {
        unlistenFn = u;
      });
    } catch {
      /* ignore */
    }

    const timer = window.setTimeout(() => finish(null), TIMEOUT_MS);

    // 先注册监听，再开窗，避免错过事件
    // Android 兼容：Rust 侧不再用 initialization_script（该 API 在 Android 编译不过），
    // 改由前端把抓取脚本 eval 注入登录子窗口（window.__TAURI__.event.emit 全局可用）
    invoke('open_netdisk_login', { url: p.loginUrl })
      .catch(() => finish(null));
    // 等登录窗口 WebView 就绪后注入抓取脚本
    window.setTimeout(() => {
      Webview.getWebviewByLabel('netdisk-login')
        .then((wv) => wv?.eval(buildCaptureScript(p)))
        .catch(() => { /* 窗口可能已关闭 */ });
    }, 1500);
  });
}
