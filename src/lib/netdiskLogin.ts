// C3 登录执行器：调用 Rust 命令 open_netdisk_login 打开官网登录窗口
// （Rust 侧用 initialization_script 注入抓取脚本），登录成功后监听
// 'netdisk-captured' 事件拿到 token，再调用 close_netdisk_login 关窗。
// 依赖 @tauri-apps/api（App 运行在 Tauri 内）。
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
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
    invoke('open_netdisk_login', { url: p.loginUrl, script: buildCaptureScript(p) })
      .catch(() => finish(null));
  });
}
