// C3 登录执行器（V3.7.8 重写）
// 背景：
//  - V3.7.5 用主 WebView navigate，但 Tauri Android 单 WebView 套壳 UA 被官网识破 → 强推下载页；
//  - V3.7.7 改系统浏览器 open()，夸克/UC 仍是下载页，且外部浏览器无法加返回按钮；
// V3.7.8 修正：改用 Rust 命令 open_netdisk_login，在 App 内 WebView 打开登录页 +
//  Android 强制桌面 UA（官网给真实登录框）+ 注入悬浮返回按钮 + 自动抓 token。
//  阿里/夸克/UC 都能进登录页，且顶部有「返回幕海」按钮，点完自动回 App 并写 token。
import { invoke } from '@tauri-apps/api/core';
import { type NetdiskProvider, buildCaptureNavScript } from './netdisk';

/**
 * 在 App 内 WebView 打开官网登录页（走 Rust 命令，带桌面 UA + 注入脚本）。
 * @returns 无。成功与否由 Rust 端 toast / 页面跳转体现；失败会抛错到调用方。
 */
export async function openNetdiskLogin(p: NetdiskProvider): Promise<void> {
  // 记录当前 App 地址（含 hash），供 Rust 跳回时使用；去掉 ndtok 等残留参数
  const back = (window.location.href.split('#')[0] || '').replace(/[?&]ndtok=[^&]+/g, '').replace(/\?$/, '');
  const captureScript = buildCaptureNavScript(p);
  await invoke('open_netdisk_login', {
    url: p.loginUrl,
    backUrl: back,
    provider: p.key,
    captureScript,
  });
}
