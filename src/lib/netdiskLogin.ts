// C3 登录执行器（V3.7.7 重写）
// 背景：
//  - V3.7.5 用主 WebView navigate 到官网，但 Tauri Android 单 WebView 套壳 UA 被官网识破，强推「下载页」；
//  - V3.7.6 改用 getCurrentWebview()，结果 navigate 在安卓真机不触发，三个网盘都进不去（回退 bug）。
// V3.7.7 修正：改用 @tauri-apps/plugin-shell 的 open() 拉起**系统浏览器**到登录页。
//  系统浏览器环境完整，官网必定给真实登录框（影视仓同款做法），100% 进登录页面。
//  登录后 token 由用户在浏览器复制，回 App 用「手动粘贴授权」面板录入（V3.7.6 已加）。
//  若系统浏览器拉起失败，再退回主 WebView 导航（桌面端 WebView 为真实浏览器内核，可用）。
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { type NetdiskProvider } from './netdisk';

/**
 * 用系统浏览器打开官网登录页。本函数不再自动抓 token（真机 WebView 注入不可靠），
 * token 统一由「手动粘贴授权」面板录入。返回 null 表示走的是"外部浏览器 + 手动粘贴"流程。
 */
export async function openNetdiskLogin(p: NetdiskProvider): Promise<null> {
  // 主路径：系统浏览器打开（环境完整，官网给真实登录框，且 100% 能跳）
  try {
    await shellOpen(p.loginUrl);
    return null;
  } catch {
    /* 系统浏览器拉起失败，走兜底 */
  }
  // 兜底 1：退回主 WebView 导航（桌面端 WebView 为真实浏览器内核，可用；移动端可能被推下载页）
  try {
    const wv = (window as any).Webview?.getCurrent?.();
    if (wv && typeof wv.navigate === 'function') {
      await wv.navigate(p.loginUrl);
      return null;
    }
  } catch {
    /* ignore */
  }
  // 兜底 2：最后的手段（直接改 location）
  try {
    window.location.href = p.loginUrl;
  } catch {
    /* ignore */
  }
  return null;
}
