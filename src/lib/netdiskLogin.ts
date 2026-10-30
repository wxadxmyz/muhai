// C3 登录执行器（V3.7.8 重写）
// 背景：
//  - V3.7.5 用主 WebView navigate，但 Tauri Android 单 WebView 套壳 UA 被官网识破 → 强推下载页；
//  - V3.7.7 改系统浏览器 open()，夸克/UC 仍是下载页，且外部浏览器无法加返回按钮；
// V3.7.8 修正：改用 Rust 命令 open_netdisk_login，在 App 内 WebView 打开登录页 +
//  Android 强制桌面 UA（官网给真实登录框）+ 注入悬浮返回按钮 + 自动抓 token。
//  阿里/夸克/UC 都能进登录页，且顶部有「返回幕海」按钮，点完自动回 App 并写 token。
import { invoke } from '@tauri-apps/api/core';
import { type NetdiskProvider, type NetdiskKey, buildCaptureNavScript, setNetdiskToken } from './netdisk';

/**
 * 在 App 内打开官网登录页（走 Rust 命令）。
 *  - Android：由原生 NetdiskLoginActivity（独立 WebView + 原生顶栏）接管，命令会在用户
 *    关闭登录页后返回 {provider, token}；主 WebView 不被导航，返回不会整页重载（"重启"）。
 *  - 桌面：仍走主 WebView 内导航，token 由 hash 回跳/事件消费，命令返回 null。
 * @returns 无。拿到的 token 在此直接落盘并触发"已挂载列表"刷新。
 */
export async function openNetdiskLogin(p: NetdiskProvider): Promise<void> {
  // 记录当前 App 地址（保留 hash 路由），供桌面端 Rust 跳回时使用；去掉 ndtok 残留参数。
  const u = new URL(window.location.href);
  u.searchParams.delete('ndtok');
  const back = u.toString();
  const captureScript = buildCaptureNavScript(p);
  const res = await invoke<{ provider: string; token: string } | null>('open_netdisk_login', {
    url: p.loginUrl,
    backUrl: back,
    provider: p.key,
    captureScript,
  });
  // V4.1.6 A：原生登录页返回的 token 在此落盘（桌面端走原事件/hash 通道，res 为 null）。
  if (res && res.token) {
    setNetdiskToken(res.provider as NetdiskKey, res.token);
  }
}
