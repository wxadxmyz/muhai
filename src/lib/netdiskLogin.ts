// C3 登录执行器（V3.2.5 选项 B：Android 兼容重构）
// 背景：V3.2.4 用独立 WebView 窗口（WebviewWindowBuilder）打开登录页，但 Tauri v2 在
// Android 上不支持多 WebView 窗口（编译失败），故回退后 Android 无 C3。
// 选项 B：放弃独立窗口，改为在主 WebView 内直接导航到网盘登录页，前端注入抓取脚本，
// 抓到 token 后把主 WebView 跳回 App，并把 token 带在 URL query 里完成回传。
// 这样桌面 / Android 走同一套逻辑，无需 Rust 侧 open_netdisk_login 命令，规避 Android 编译坑。
//
// 回传机制：登录页内的抓取脚本抓到 token 后设置
//   window.location.href = <App地址>?ndtok=<provider>:<token>
// 主 WebView 跳回 App 重新加载；startup（main.tsx）调用 syncNetdiskTokens() 消费 query 写入。
import { Webview } from '@tauri-apps/api/webview';
import { buildCaptureNavScript, setNetdiskToken, type NetdiskProvider } from './netdisk';

const TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟超时

/**
 * 打开官网登录页，登录成功后自动捕获 token 并存入已挂载列表。
 * 实现：主 WebView 导航到登录页 → 注入抓取脚本 → 抓到后跳回 App（token 随 query 回传）。
 * @returns Promise<token|null> 捕获到的 token（超时/失败返回 null）
 */
export function openNetdiskLogin(p: NetdiskProvider): Promise<string | null> {
  return new Promise((resolve) => {
    // 记下当前 App 地址（去掉 hash），抓取成功后跳回
    const appHref = window.location.href.split('#')[0];
    let done = false;
    const finish = (token: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('popstate', onTok);
      resolve(token);
    };

    // 跳回 App 后页面会 reload，原实例通常已卸载；这里补一个监听，若当前实例仍在
    // （如个别平台未 reload）则直接拿到并 resolve。主路径依赖 startup 的 syncNetdiskTokens。
    const onTok = () => {
      const m = (window.location.search || '').match(/ndtok=([^&]+)/);
      if (!m) return;
      const raw = decodeURIComponent(m[1]);
      const ci = raw.indexOf(':');
      if (ci > 0 && raw.slice(0, ci) === p.key) {
        const token = raw.slice(ci + 1);
        setNetdiskToken(p.key, token);
        finish(token);
      }
    };
    window.addEventListener('popstate', onTok);

    const timer = window.setTimeout(() => finish(null), TIMEOUT_MS);

    // 在主 WebView 内打开登录页（替代独立窗口，Android 兼容）
    const go = () => {
      try {
        Webview.getCurrent()
          .then((wv) => wv.navigate(p.loginUrl))
          .catch(() => {
            window.location.href = p.loginUrl; // 兜底：直接导航
          });
      } catch {
        window.location.href = p.loginUrl;
      }
    };
    go();

    // 等登录页加载后，注入抓取脚本（复用 netdisk.ts 的 getter 逻辑，抓到后跳回 App）
    window.setTimeout(() => {
      Webview.getCurrent()
        .then((wv) => wv.eval(buildCaptureNavScript(p, appHref)))
        .catch(() => { /* 登录页可能已关闭 */ });
    }, 2000);
  });
}
