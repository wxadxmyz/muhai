// C3（v3.2.4 重做版）：本地官网登录 → 自动捕获 Token，不走 alist 网关。
// 支持：阿里云盘 / 夸克网盘 / UC 网盘。
// 流程：设置「网盘」→ 点某盘 → 在 App 内独立 WebView 加载官网登录页 → 用户登录 →
//       注入 JS 读 localStorage/cookie 抓到 token → 回传主窗口 → 存入「已挂载列表」→ 长按复制。
//
// 播放侧对接：启动时把已存 token 同步到 window.__netdiskTokens（{ali,quark,uc}），
// 社区 drpy2 网盘源的 rule 脚本里用 globalThis.__netdiskTokens.<provider> 拼请求头即可，引擎无需改动。

export type NetdiskKey = 'ali' | 'quark' | 'uc';

export interface NetdiskProvider {
  key: NetdiskKey;
  label: string;
  color: string;
  loginUrl: string;
  /** 抓 token 的方式 */
  captureMode: 'localStorage' | 'cookie';
  /** localStorage 的键名（captureMode=localStorage 时） */
  lsKey?: string;
  /** 登录态校验正则（源码字符串）：未登录时 cookie/缓存里也有跟踪类数据，
   *  必须命中这些"用户身份"特征才算真正登录，避免误抓到空壳凭据。 */
  mustMatch: string;
  /** 抓到后，构造给 spider 的请求头名（阿里用 Authorization，夸克/UC 用 cookie） */
  headerName: string;
  /** 提示文案 */
  hint: string;
}

export const NETDISKS: NetdiskProvider[] = [
  {
    key: 'ali',
    label: '阿里云盘',
    color: '#6a7cff',
    loginUrl: 'https://www.aliyundrive.com/sign/in',
    captureMode: 'localStorage',
    lsKey: 'token',
    mustMatch: 'access_token|refresh_token',
    headerName: 'Authorization',
    hint: '登录后网页会把 token 存进 localStorage，自动抓取 refresh_token/access_token',
  },
  {
    key: 'quark',
    label: '夸克网盘',
    color: '#2b6ff2',
    // V3.7.8：用网页版入口（桌面 UA 下才会出登录框，移动 UA 会被推到下载页）
    loginUrl: 'https://pan.quark.cn/',
    captureMode: 'cookie',
    mustMatch: 'PUID|b-user-id|__pus|kps',
    headerName: 'cookie',
    hint: '登录后自动抓取网页 cookie（夸克 API 用 cookie 鉴权）',
  },
  {
    key: 'uc',
    label: 'UC网盘',
    color: '#ff6a00',
    // V3.7.8：用网页版登录页（drive.uc.cn，桌面 UA 下出登录框）
    loginUrl: 'https://drive.uc.cn/',
    captureMode: 'cookie',
    mustMatch: 'PUID|uc_uid|b-user-id|kps',
    headerName: 'cookie',
    hint: '登录后自动抓取网页 cookie（UC API 用 cookie 鉴权）',
  },
];

export function providerOf(key: NetdiskKey): NetdiskProvider {
  return NETDISKS.find((n) => n.key === key) ?? NETDISKS[0];
}

const STORE_KEY = 'muhai_netdisk_tokens';

type TokenMap = Partial<Record<NetdiskKey, string>>;

function readStore(): TokenMap {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as TokenMap) : {};
  } catch {
    return {};
  }
}

function writeStore(map: TokenMap) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  // 同步到全局，供 drpy2 网盘源 rule 脚本取用
  (window as any).__netdiskTokens = { ...(window as any).__netdiskTokens, ...map };
  // P3/P7：token 已变更，通知其它组件（如设置页「已挂载」列表）即时刷新，
  // 即便变更发生在主 WebView 当前页面之外的登录回收流程里。
  try {
    window.dispatchEvent(new CustomEvent('netdisk-tokens-changed'));
  } catch {
    /* ignore */
  }
}

/** 启动时调用：把已存 token 挂到 window，供 spider 引擎读取。
 *  选项 B（V3.2.5）：若 URL query 携带网盘登录回传的 token（主 WebView 跳回 App 时带入，
 *  形如 ?ndtok=<provider>:<token>），先消费并写入，再清除参数，避免重复消费。 */
export function syncNetdiskTokens() {
  try {
    const m = (window.location.search || '').match(/ndtok=([^&]+)/);
    if (m) {
      const raw = decodeURIComponent(m[1]);
      const ci = raw.indexOf(':');
      if (ci > 0) {
        const key = raw.slice(0, ci) as NetdiskKey;
        const token = raw.slice(ci + 1);
        if (token) {
          const map = readStore();
          map[key] = token;
          writeStore(map);
        }
      }
      // 清除 ?ndtok，避免下次 startup 重复消费
      try {
        const cleaned = window.location.search.replace(/[?&]ndtok=[^&]+/, '').replace(/\?$/, '');
        history.replaceState(null, '', window.location.pathname + cleaned + window.location.hash);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  (window as any).__netdiskTokens = readStore();
}

export function getNetdiskToken(key: NetdiskKey): string | undefined {
  return readStore()[key];
}

export function getAllNetdiskTokens(): TokenMap {
  return readStore();
}

export function setNetdiskToken(key: NetdiskKey, token: string) {
  const map = readStore();
  map[key] = token;
  writeStore(map);
}

export function clearNetdiskToken(key: NetdiskKey) {
  const map = readStore();
  delete map[key];
  writeStore(map);
}

/**
 * 生成注入到登录页的轮询脚本：每秒尝试抓一次 token，抓到后通过
 *  ① Tauri 事件 emit('netdisk-captured')（首选）
 *  ② window.opener.postMessage（兜底）
 * 两种通道回传主窗口。
 */
export function buildCaptureScript(p: NetdiskProvider): string {
  const must = JSON.stringify(p.mustMatch || '');
  // 必须命中登录态特征（mustMatch）才算登录成功，避免抓到未登录时的跟踪 cookie
  const getter =
    p.captureMode === 'localStorage'
      ? `(function(){try{var v=localStorage.getItem(${JSON.stringify(p.lsKey)});if(v&&new RegExp(${must}).test(v))return v;}catch(e){}return '';})()`
      : `(function(){try{var c=document.cookie;if(c&&new RegExp(${must}).test(c))return c;}catch(e){}return '';})()`;
  return `(function(){
  if (window.__ndPoll) return;
  window.__ndPoll = setInterval(function(){
    var t = ${getter};
    if (t) {
      clearInterval(window.__ndPoll);
      var payload = { provider: ${JSON.stringify(p.key)}, token: t };
      try { window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.emit('netdisk-captured', payload); } catch(e){}
      try { window.opener && window.opener.postMessage({ __netdisk: payload }, '*'); } catch(e2){}
    }
  }, 1000);
})();`;
}

/**
 * V3.7.8：注入到网盘登录页的脚本。负责三件事：
 *  1) 顶部沉浸式「返回幕海」顶栏（P2：背景铺满状态栏、内容下移到安全区，三网盘差异化配色）；
 *  2) 轮询抓 token，命中登录态特征后调 close_netdisk_login 回 App（token 不再走 URL，见 P3）；
 *  3) P8：装一层历史陷阱，手势/系统返回键触发 popstate 而非离开页面，由 Rust 恢复 UA 并回 App。
 * 脚本对登录页是"可信注入"（webview.eval），不受页面 CSP 限制；用 setInterval 反复尝试，
 * 避开页面未加载完 document.body 的时序问题。
 */
export function buildCaptureNavScript(p: NetdiskProvider): string {
  const must = JSON.stringify(p.mustMatch || '');
  const lsKey = JSON.stringify(p.lsKey);
  // 注意：getter 是「函数表达式」而不是 IIFE 结果——每次轮询都要重新读 localStorage/cookie，
  // 否则只在注入瞬间取一次值，登录后再也不会命中。
  const getter =
    p.captureMode === 'localStorage'
      ? `function(){try{var v=localStorage.getItem(${lsKey});if(v&&new RegExp(${must}).test(v))return v;}catch(e){}return '';}`
      : `function(){try{var c=document.cookie;if(c&&new RegExp(${must}).test(c))return c;}catch(e){}return '';}`;
  // 返回 / 抓到 token 后调用 Rust 命令；withGlobalTauri 已在 tauri.conf 开启
  // V4.1.1 ⑧：invoke 返回的是 Promise——远程登录页里这个调用此前被 ACL 拦截
  // （capability 没配 remote.urls），而同步 try/catch 抓不到异步 reject，按钮"按了
  // 没反应"就是这么来的（静默失败）。补 .catch 让失败至少在控制台现形；
  // 同时删掉全仓库无人定义的 __ndFallback 死代码分支。
  const close = `function __ndClose(tok){try{if(window.__TAURI__&&window.__TAURI__.invoke){window.__TAURI__.invoke('close_netdisk_login',tok?{token:tok}:{}).catch(function(e){try{console.error('[netdisk] close_netdisk_login rejected',e);}catch(_e){}});}else{try{console.error('[netdisk] window.__TAURI__ unavailable on login page');}catch(_e){}}}catch(e){try{console.error('[netdisk] __ndClose sync error',e);}catch(_e){}}}`;
  // P2：三网盘沉浸式顶栏主题（阿里深色；夸克/UC 浅色——状态栏图标深浅由系统决定，浅底最稳）
  const theme =
    p.key === 'ali'
      ? { bg: '#0f1524', fg: '#ffffff', sep: 'none' }
      : p.key === 'quark'
        ? { bg: '#ffffff', fg: '#1a1a1a', sep: '1px solid rgba(0,0,0,.06)' }
        : { bg: '#ffffff', fg: '#1a1a1a', sep: '2px solid ' + (p.color || '#ff6a00') };
  return `(()=>{
  ${close}
  var __ND_PROVIDER = ${JSON.stringify(p.key)};
  var __ND_GETTER = ${getter};
  var __ND_MATCH = ${must};
  var __ND_DONE = false;
  // P2：沉浸式顶栏主题（来自 buildCaptureNavScript 注入）
  var __ND_THEME = ${JSON.stringify(theme)};

  // P8：返回陷阱——手势/系统返回键触发 popstate 而非离开页面；接住后走正常关闭流程
  // （Rust 恢复 UA、导航回 App）。已在 close 流程里就不重复拦，避免打断自动关闭。
  try {
    history.pushState({ __ndTrap: 1 }, '', location.href);
    window.addEventListener('popstate', function () {
      if (__ND_DONE) return;
      __ND_DONE = true;
      try { history.pushState({ __ndTrap: 1 }, '', location.href); } catch (e) {}
      __ndClose(null);
    });
  } catch (e) {}

  // 悬浮返回顶栏（沉浸式：背景铺满状态栏，内容下移到安全区）
  function __ndEnsureBar(){
    if (document.getElementById('__nd_bar')) return;
    var TOP = (typeof __ND_TOP !== 'undefined' && __ND_TOP > 0) ? __ND_TOP : 0; // 来自 Rust JNI 实测状态栏高度
    var H = 48;
    var bg = __ND_THEME.bg, fg = __ND_THEME.fg, sep = __ND_THEME.sep;
    var bar = document.createElement('div');
    bar.id = '__nd_bar';
    bar.style.cssText =
      'position:fixed!important;left:0!important;right:0!important;top:0!important;' +
      'height:' + (TOP + H) + 'px!important;padding-top:' + TOP + 'px!important;' +
      'box-sizing:border-box!important;display:flex!important;align-items:center!important;' +
      'background:' + bg + '!important;color:' + fg + '!important;' +
      'border-bottom:' + sep + '!important;' +
      'z-index:2147483647!important;';
    bar.innerHTML =
      '<div id="__nd_close" style="width:44px;height:44px;flex:0 0 44px;display:flex;align-items:center;justify-content:center;cursor:pointer;">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="' + fg + '" stroke-width="1.6" stroke-linecap="round">' +
          '<path d="M6 6l12 12M18 6L6 18"/></svg></div>' +
      '<div style="flex:1;text-align:center;font-size:16px;font-weight:500;letter-spacing:.5px;">登录' + ${JSON.stringify(p.label)} + '</div>' +
      '<div style="width:44px;flex:0 0 44px;text-align:center;font-size:11px;opacity:.55;">幕海</div>';
    bar.querySelector('#__nd_close').onclick = function(){
      if(!__ND_DONE){ __ND_DONE = true; __ndClose(null); }
    };
    (document.body||document.documentElement).appendChild(bar);
    if (document.body) document.body.style.paddingTop = (TOP + H) + 'px';
  }

  // 每秒：确保顶栏在；抓 token
  setInterval(function(){
    try { __ndEnsureBar(); } catch(e){}
    if (__ND_DONE) return;
    var t = '';
    try { t = __ND_GETTER(); } catch(e){ t = ''; }
    if (t) {
      __ND_DONE = true;
      try { __ndClose(t); } catch(e){}
    }
  }, 1000);
  // 立即先来一次（页面已就绪时）
  try { __ndEnsureBar(); } catch(e){}
})();`;
}
