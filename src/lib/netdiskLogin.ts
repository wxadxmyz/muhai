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
//
// V3.7.5 #5：登录页是外部站点（主 WebView 已导航到外部域），App 的 React 导航栏被替换，
// 故注入浮动「返回」按钮回到「网盘登录页」；并在超时/取消时兜底导航回 App。
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
    let finish = (token: string | null) => {
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

    // 在主 WebView 内打开登录页（替代独立窗口，Android 兼容）。V3.7.5 #5：getCurrent 为同步返回。
    const go = () => {
      try {
        ((Webview.getCurrent()) as any).navigate(p.loginUrl);
      } catch {
        window.location.href = p.loginUrl; // 兜底：直接导航
      }
    };
    go();

    // V3.7.5 #5：登录页是外部站点，App 的 React 导航栏已被替换，故注入一个浮动「返回」按钮，
    // 点击 history.back() 回到「网盘登录页」（主 WebView 历史栈里仍保留着 App 页）。
    const BACK_BTN_ID = '__muhai_back_btn';
    const injectBackButton = () => {
      try {
        ((Webview.getCurrent()) as any).eval(
          `(function(){if(document.getElementById('${BACK_BTN_ID}'))return;var b=document.createElement('div');` +
          `b.id='${BACK_BTN_ID}';b.textContent='← 返回';` +
          `b.style.cssText='position:fixed;top:10px;left:10px;z-index:2147483647;background:rgba(0,0,0,.72);` +
          `color:#fff;padding:9px 14px;border-radius:10px;font-size:14px;font-family:sans-serif;cursor:pointer';` +
          `b.addEventListener('click',function(){history.back();});` +
          `(document.body||document.documentElement).appendChild(b);})();`
        );
      } catch { /* 注入失败不影响抓取 */ }
    };
    // 登录页加载需要时间，延后注入；再补一次兜底（部分站点二次跳转后才挂载 body）
    window.setTimeout(injectBackButton, 1500);
    window.setTimeout(injectBackButton, 4000);

    // 等登录页加载后，注入抓取脚本（复用 netdisk.ts 的 getter 逻辑，抓到后跳回 App）
    window.setTimeout(() => {
      try {
        ((Webview.getCurrent()) as any).eval(buildCaptureNavScript(p, appHref));
      } catch { /* 登录页可能已关闭 */ }
    }, 2000);

    // 超时 / 取消后兜底：若仍停在外部登录页，跳回 App（避免卡在外部页或回到桌面）
    const origFinish = finish;
    finish = (token: string | null) => {
      try {
        const curBase = (window.location.href.split('#')[0] || '');
        const appBase = (appHref.split('#')[0] || 'x');
        if (!curBase.startsWith(appBase)) ((Webview.getCurrent()) as any).navigate(appHref);
      } catch {
        try { window.location.href = appHref; } catch { /* ignore */ }
      }
      origFinish(token);
    };
  });
}
