// C3 登录执行器（V3.7.6 重写）
// 背景：V3.2.5 用「主 WebView 直接 navigate 到登录页」替代独立窗口（Android 兼容）。
// 但 V3.7.5 的实现把「返回按钮注入」「token 抓取脚本」都挂在 App 页的 window.setTimeout 上，
// 而 navigate() 会卸载 App 页，这些定时器随 App 页一起被销毁，永远不执行——
// 结果外部登录页既没有返回按钮、也没有抓取脚本，用户卡在外部页回不来（且官方页常推下载页）。
//
// V3.7.6 修正：
//  ① 注入改挂 Webview 层事件 onPageLoad（页面每次加载完成即触发，不依赖被卸载的 App 页定时器）；
//  ② 外部登录页加载完成后注入浮动「← 返回」按钮（history.back() 回网盘登录页）与 token 抓取脚本；
//  ③ token 抓取脚本抓到后 emit('netdisk-captured') 事件（需 withGlobalTauri），由本模块的
//     listen 立即接收并 resolve；同时脚本会把主 WebView 跳回 App（?ndtok=...），由 startup 的
//     syncNetdiskTokens 兜底写入，双保险。
//  ④ 超时/取消兜底：若仍停在外部页则跳回 App，避免卡死。
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { buildCaptureNavScript, setNetdiskToken, type NetdiskProvider } from './netdisk';

const TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟超时

/**
 * 打开官网登录页，登录成功后自动捕获 token 并存入已挂载列表。
 * 实现：主 WebView 导航到登录页 → onPageLoad 注入返回按钮+抓取脚本 → 抓到后回传。
 * @returns Promise<token|null> 捕获到的 token（超时/失败返回 null）
 */
export function openNetdiskLogin(p: NetdiskProvider): Promise<string | null> {
  return new Promise((resolve) => {
    // 记下当前 App 地址（去掉 hash），抓取成功后跳回
    const appHref = window.location.href.split('#')[0];
    let done = false;
    const cleanups: Array<() => void> = [];
    const cleanup = () => {
      while (cleanups.length) {
        const fn = cleanups.pop();
        try { fn && fn(); } catch { /* ignore */ }
      }
    };
    const finish = (token: string | null) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(token);
    };

    // Tauri 2 运行时 Webview 自带 navigate / eval / onPageLoad，但当前 @tauri-apps/api 类型未声明，
    // 故用最小接口断言（运行时真实存在这些方法，之前 V3.7.5 也用 as any 调过）。
    type WebviewLike = {
      navigate(url: string): Promise<void>;
      eval(script: string): Promise<string>;
      onPageLoad(cb: (e: { payload: { url: string; event: 'started' | 'finished' } }) => void): Promise<UnlistenFn>;
    };
    const wv = getCurrentWebview() as unknown as WebviewLike;

    // ③ 监听抓取脚本发出的 Tauri 事件（withGlobalTauri 开启时生效，作为快速回传通道）
    listen<{ provider: string; token: string }>('netdisk-captured', (e) => {
      const d = e.payload;
      if (d && d.provider === p.key) {
        setNetdiskToken(p.key, d.token);
        finish(d.token);
      }
    }).then((un: UnlistenFn) => cleanups.push(un)).catch(() => {});

    // ② 外部登录页加载完成后注入：浮动「返回」按钮 + token 抓取脚本。
    // 仅对外部域注入，避免污染 App 自身页面（App 页是 tauri.localhost / localhost）。
    const BACK_BTN_ID = '__muhai_back_btn';
    const injectOnExternal = (url: string) => {
      let host = '';
      try { host = new URL(url).hostname; } catch { /* ignore */ }
      const isApp = !host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('tauri.localhost');
      if (isApp) return; // 只在外部登录页注入
      try {
        wv.eval(
          `(function(){
            if(document.getElementById('${BACK_BTN_ID}'))return;
            var b=document.createElement('div');
            b.id='${BACK_BTN_ID}';
            b.textContent='← 返回';
            b.style.cssText='position:fixed;top:12px;left:12px;z-index:2147483647;background:rgba(0,0,0,.72);'+
              'color:#fff;padding:9px 14px;border-radius:10px;font-size:14px;font-family:sans-serif;cursor:pointer';
            b.addEventListener('click',function(){history.back();});
            (document.body||document.documentElement).appendChild(b);
          })();`
        );
      } catch { /* 返回按钮注入失败不影响抓取 */ }
      // 抓取脚本抓到 token 后跳回 App（?ndtok 回传），由 startup 的 syncNetdiskTokens 消费
      try { wv.eval(buildCaptureNavScript(p, appHref)); } catch { /* ignore */ }
    };

    // ① 核心修复：在 Webview 层监听页面加载完成（导航后依然有效，不依赖被卸载的 App 页定时器）
    wv.onPageLoad((event) => {
      if (event.payload.event !== 'finished') return;
      injectOnExternal(event.payload.url);
    }).then((un: UnlistenFn) => cleanups.push(un)).catch(() => {});

    // 跳回 App 后页面会 reload，原实例通常已卸载；这里仅作保险，主路径依赖 syncNetdiskTokens。
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
    cleanups.push(() => window.removeEventListener('popstate', onTok));

    // 主 WebView 导航到外部登录页（替代独立窗口，Android 兼容）
    try {
      wv.navigate(p.loginUrl);
    } catch {
      window.location.href = p.loginUrl; // 兜底：直接导航
    }

    // ④ 超时 / 取消兜底：若仍停在外部登录页，跳回 App（避免卡在外部页或回到桌面）
    const timer = window.setTimeout(() => {
      try {
        const curBase = (window.location.href.split('#')[0] || '');
        if (!curBase.startsWith(appHref)) wv.navigate(appHref);
      } catch {
        try { window.location.href = appHref; } catch { /* ignore */ }
      }
      finish(null);
    }, TIMEOUT_MS);
    cleanups.push(() => clearTimeout(timer));
  });
}
