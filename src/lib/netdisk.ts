// C3（v3.2.4 重做版）：本地官网登录 → 自动捕获 Token，不走 alist 网关。
// 支持：阿里云盘 / 夸克网盘 / UC 网盘。
// 流程：设置「网盘」→ 点某盘 → 在 App 内独立 WebView 加载官网登录页 → 用户登录 →
//       注入 JS 读 localStorage/cookie 抓到 token → 回传主窗口 → 存入「已挂载列表」→ 长按复制。
//
// 播放侧对接：启动时把已存 token 同步到 window.__netdiskTokens（{ali,quark,uc}），
// 社区 drpy2 网盘源的 rule 脚本里用 globalThis.__netdiskTokens.<provider> 拼请求头即可，引擎无需改动。

import { invoke } from '@tauri-apps/api/core';

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
    // V4.1.6 ②：进一步去掉设备匿名 cookie b-user-id（未登录就存在），只保留登录后
    // 才出现的用户标识 PUID，彻底消除"还没输密码就误抓 cookie → 误显示已登录"。
    mustMatch: 'PUID',
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
    // V4.1.6 ②：去掉设备匿名 cookie（uc_uid/b-user-id，未登录就存在），只保留登录后出现的 PUID。
    mustMatch: 'PUID',
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
/** 从 URL（search 或 hash）消费网盘登录回传的 token 并落盘；返回是否被消费。 */
export function consumeNetdiskTokenFromUrl(): boolean {
  try {
    const m =
      (window.location.search || '').match(/ndtok=([^&]+)/) ||
      (window.location.hash || '').match(/[?&]ndtok=([^&]+)/);
    if (m) {
      const raw = decodeURIComponent(m[1]);
      const ci = raw.indexOf(':');
      if (ci > 0) {
        const key = raw.slice(0, ci) as NetdiskKey;
        const token = raw.slice(ci + 1);
        if (token) {
          const map = readStore();
          map[key] = token;
          writeStore(map); // 内部会 dispatch 'netdisk-tokens-changed'，触发挂载列表即时刷新
        }
      }
      // 清除 ndtok（search 或 hash 内），避免重复消费
      try {
        let url = window.location.href
          .replace(/[?&]ndtok=[^&]+/, '')
          .replace(/#&/, '#')
          .replace(/\?$/, '')
          .replace(/#\?$/, '#');
        history.replaceState(null, '', url);
      } catch { /* ignore */ }
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** 启动时调用：把已存 token 挂到 window，并消费 URL 中可能携带的回传 token。 */
export function syncNetdiskTokens() {
  consumeNetdiskTokenFromUrl();
  (window as any).__netdiskTokens = readStore();
}

/** 在 App 顶层注册 hashchange / visibilitychange 监听，自动消费登录回跳带来的 token
 *  （登录后回到 App 不重启，hashchange 会触发；从后台切回也会触发）。 */
export function setupNetdiskTokenListener() {
  const handler = () => {
    consumeNetdiskTokenFromUrl();
  };
  window.addEventListener('hashchange', handler);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handler();
  });
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

// V4.1.6 E：把幕海已登录的阿里 refresh_token 注入到 drpy 规则源码里。
// 社区规则（如玩偶哥哥 wogg.js）用 `var ALI_REFRESH_TOKEN = ''` 硬编码空令牌，
// 不填则能搜不能播。这里把它替换成当前已登录的阿里 refresh_token（从 localStorage
// 的 token JSON 解析），让这类规则直接复用本地登录态，无需用户手动改规则。
// 仅当规则源码确实声明了 ALI_REFRESH_TOKEN 时才替换，其它规则不受影响。
export function injectAliRefreshToken(code: string): string {
  if (!code || !/ALI_REFRESH_TOKEN/.test(code)) return code;
  const ali = getAllNetdiskTokens().ali;
  let refreshToken = '';
  if (ali) {
    try {
      const j = JSON.parse(ali);
      if (j && typeof j.refresh_token === 'string' && j.refresh_token) refreshToken = j.refresh_token;
      else if (j && typeof j.access_token === 'string' && j.access_token) refreshToken = j.access_token;
    } catch {
      // 存的就是裸 token（非 JSON）
      refreshToken = ali;
    }
  }
  // 只替换声明处的空/占位赋值，避免破坏规则其它逻辑
  return code.replace(
    /(var\s+ALI_REFRESH_TOKEN\s*=\s*)(['"])(?:[^'"]*)\2(\s*;)/,
    `$1${JSON.stringify(refreshToken)}$3`,
  );
}

export interface NdFile {
  name: string;
  id: string;
  isDir: boolean;
  size: number;
}

// V4.1.3 #7：已登录网盘文件浏览——经 Rust fetchmedia 代理（带鉴权头 + body）请求各盘 API，
// 绕开 WebView 的 CORS 与 Android 明文限制。阿里/夸克/UC 的个人 API 普遍需要逆向签名
// （x-sign / pr / sign），未签名请求可能被服务端拒绝；此处 best-effort 适配，调用失败由 UI 友好提示。
async function ndRequest(url: string, headers: Record<string, string>, body?: string): Promise<any> {
  const res = await invoke<{ data: string; url: string }>('fetchmedia', { url, headers, body });
  const text = atob(res.data);
  return JSON.parse(text);
}

export async function listNetdiskFiles(key: NetdiskKey, token: string, parentId: string): Promise<NdFile[]> {
  if (key === 'ali') return await aliList(token, parentId);
  if (key === 'quark') return await quarkList(token, parentId);
  if (key === 'uc') return await ucList(token, parentId);
  return [];
}

async function aliList(token: string, parentId: string): Promise<NdFile[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-device-id': 'null',
  };
  const info = await ndRequest('https://api.aliyundrive.com/v2/user/getDriveInfo', headers, '{}');
  const driveId = info?.default_drive_id || info?.drive_id;
  if (!driveId) throw new Error('无法获取阿里云盘 driveId');
  const list = await ndRequest(
    'https://api.aliyundrive.com/v2/file/list',
    headers,
    JSON.stringify({
      drive_id: driveId,
      parent_file_id: parentId || 'root',
      limit: 100,
      order_by: 'name',
      order_direction: 'ASC',
    }),
  );
  return (list?.items || []).map((f: any) => ({
    name: f.name,
    id: f.file_id,
    isDir: f.type === 'folder',
    size: f.size || 0,
  }));
}

async function quarkList(token: string, parentId: string): Promise<NdFile[]> {
  const headers: Record<string, string> = { cookie: token, 'Content-Type': 'application/json' };
  const body = JSON.stringify({
    parentId: parentId || '',
    fileId: parentId || '',
    page: 1,
    pageSize: 100,
    orderBy: 'name',
    orderDirection: 'asc',
  });
  const r = await ndRequest('https://drive-pan.quark.cn/1/clouddrive/file/sort', headers, body);
  const arr = r?.data?.list || [];
  return arr.map((f: any) => ({
    name: f.file_name,
    id: f.fid,
    isDir: f.file_type === 0 || f.file_type === 1,
    size: f.size || 0,
  }));
}

async function ucList(token: string, parentId: string): Promise<NdFile[]> {
  const headers: Record<string, string> = { cookie: token, 'Content-Type': 'application/json' };
  const body = JSON.stringify({
    parentId: parentId || '0',
    orderBy: 'name',
    orderDirection: 'asc',
    pageNum: 1,
    pageSize: 100,
  });
  const r = await ndRequest('https://drive.uc.cn/api/file/list', headers, body);
  const arr = r?.data?.list || [];
  return arr.map((f: any) => ({
    name: f.name,
    id: f.id,
    isDir: f.isDir === true || f.fileType === 'folder',
    size: f.size || 0,
  }));
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
  // 回传通道说明（V4.1.5 ①②③）：抓到 token 后**仅暂存**到 window.__ND_TOKEN，不自动跳回；
  // 用户主动点 X / 手势返回时，__ndClose() 经 hash 回跳把 token 带回本地 App 页（彻底绕开远程域 ACL，
  // 阿里登录跳转到 passport.aliyun.com 等未放行域时 invoke 会被拒，hash 回跳最稳），前端 hashchange 消费落盘。
  // 无 token（手动关闭/返回键）：invoke close_netdisk_login（Rust 还原 UA + 导航回 back_url），失败再 hash 回跳兜底。
  // V4.1.4 ②：注入常量用裸变量（const/IIFE var 不挂 window，旧写法 window.__ND_BACK 恒为 '' 导致返回不了）。
  // V4.1.5：去掉"抓到 token 即跳回"——登录成功不再整页重载（避免被误认为"重启 App"），停在登录后页等用户操作。
  const close = `function __ndClose(){
    if (window.__ND_DONE) return;
    window.__ND_DONE = true;
    // 原生登录 Activity 模式（Android）：直接交还原生层处理（顶栏/X 均为原生控件，
    // 由 Kotlin NetdiskBridge 把 token 回传主 App，避免主 WebView 被导航导致的整页重载）。
    if (window.NetdiskBridge) { try { window.NetdiskBridge.close(); } catch(e){} return; }
    var b = '';
    try { b = (typeof __ND_BACK !== 'undefined' && __ND_BACK) ? __ND_BACK : ''; } catch(e){ b = ''; }
    var tok = '';
    try { tok = (typeof window.__ND_TOKEN !== 'undefined' && window.__ND_TOKEN) ? window.__ND_TOKEN : ''; } catch(e){ tok = ''; }
    var prov = '';
    try { prov = (typeof __ND_PROVIDER !== 'undefined' && __ND_PROVIDER) ? __ND_PROVIDER : ''; } catch(e){ prov = ''; }
    if (tok && b) {
      // 带回 token 的 hash 回跳：主 WebView 导航回本地 App 页，token 经 hash 带回，前端消费落盘
      var enc = encodeURIComponent(prov + ':' + tok);
      var parts = b.split('#'); var base = parts[0]; var h = parts[1] || '';
      var sep = h.indexOf('?') >= 0 ? '&' : '?';
      var target = base + '#' + h + sep + 'ndtok=' + enc;
      try { location.href = target; } catch(e){ try{ location.replace(target); }catch(e2){} }
      return;
    }
    // 无 token：走 Rust 关闭（还原 UA + 导航回 back_url）；失败再用 back_url 兜底，保证只导航一次
    if (b) {
      if (window.__TAURI__ && window.__TAURI__.invoke) {
        window.__TAURI__.invoke('close_netdisk_login', {}).catch(function(){ try { location.href = b; } catch(e){} });
      } else {
        try { location.href = b; } catch(e){}
      }
    }
  }`;
  // V4.1.3 #5：三个网盘顶栏统一软件默认白色皮肤（不再按盘差异化配色 / 去橙色分隔线）
  const theme = { bg: '#ffffff', fg: '#1a1a1a', sep: '1px solid rgba(0,0,0,.08)' };
  return `(()=>{
  ${close}
  var __ND_PROVIDER = ${JSON.stringify(p.key)};
  var __ND_GETTER = ${getter};
  var __ND_MATCH = ${must};
  // V4.1.3：__ND_DONE 挂到 window，使 Rust 每秒重注入脚本时不会被重置为 false（避免"已关闭却仍重复触发"）
  window.__ND_DONE = window.__ND_DONE || false;
  // 原生登录 Activity 标志：由宿主（Android 原生 Activity）在注入前写入，控制顶栏/陷阱走原生实现，
  // 避免注入式 DOM 顶栏在桌面 UA 下横向滑动、被通知栏压等问题（V4.1.6 C 项）。
  window.__ND_NATIVE_BAR = window.__ND_NATIVE_BAR || false;
  window.__ND_NO_TRAP = window.__ND_NO_TRAP || false;
  // P2：沉浸式顶栏主题（来自 buildCaptureNavScript 注入）
  var __ND_THEME = ${JSON.stringify(theme)};

  // V4.1.5 ②：手势/系统返回键陷阱——拦截 popstate，统一走 __ndClose() 回到网盘登录选择页
  // （V4.1.3 #3 起因：Tauri navigate 跳远程页不留回 App 的历史条目，不拦会直接退出 App）。
  // 不再"自动登录跳回"，改为用户主动触发才返回，且只走单通道，消除并发导航导致的闪退。
  try {
    if (!window.__ND_NO_TRAP && !window.__ND_TRAP) {
      window.__ND_TRAP = true;
      history.pushState({ __ndTrap: 1 }, '', location.href);
      window.addEventListener('popstate', function () {
        if (window.__ND_DONE) return;
        try { history.pushState({ __ndTrap: 1 }, '', location.href); } catch (e) {}
        __ndClose();
      });
    }
  } catch (e) {}

  // 悬浮返回顶栏（沉浸式：背景铺满状态栏，内容下移到安全区）
  // V4.1.4 ①：回退 V4.1.3 第 8 条——删除 __ndFit（整页 zoom 缩放）。
  // zoom 会把 position:fixed 的顶栏连高度带 padding 一起缩放，顶栏定位与真实状态栏对不上，
  // 表现为"顶栏被通知栏压住"；且部分 WebView 里 zoom 还会污染 getBoundingClientRect 的测量。
  // 登录页恢复成改之前的样子（不缩放）。

  function __ndEnsureBar(){
    // 原生顶栏模式：UI 由原生控件承载，JS 不再创建 DOM 顶栏（V4.1.6 C 项）
    if (window.__ND_NATIVE_BAR) return;
    var bar = document.getElementById('__nd_bar');
    if (bar) return;
    // V4.1.4 ③：状态栏高度优先取 Rust 算好的 CSS px（__ND_TOP_CSS = 物理px / density），
    // 不再在 JS 里除 devicePixelRatio —— 桌面 UA 下部分 WebView 的 DPR 会漂，
    // 除错就整条顶栏错位（表现为被通知栏压住 / 悬空）。物理值仅作旧脚本兜底。
    var TOP = 0;
    try {
      if (typeof __ND_TOP_CSS !== 'undefined' && __ND_TOP_CSS > 0) {
        TOP = __ND_TOP_CSS;
      } else if (typeof __ND_TOP !== 'undefined' && __ND_TOP > 0) {
        var DPR = window.devicePixelRatio || 1;
        TOP = DPR > 1 ? Math.round(__ND_TOP / DPR) : __ND_TOP;
      }
    } catch(e) { TOP = 0; }
    // 留 2px 余量：部分 ROM 的 status_bar_height 不含通知横幅弹出的额外高度
    if (TOP > 0) TOP += 2;
    var H = 48;
    var bg = __ND_THEME.bg, fg = __ND_THEME.fg, sep = __ND_THEME.sep;
    bar = document.createElement('div');
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
      '<div class="nd-center" style="flex:1;text-align:center;font-size:16px;font-weight:500;letter-spacing:.5px;">登录' + ${JSON.stringify(p.label)} + '</div>' +
      '<div style="width:44px;flex:0 0 44px;text-align:center;font-size:11px;opacity:.55;">幕海</div>';
    bar.querySelector('#__nd_close').onclick = function(){
      if(!window.__ND_DONE){ __ndClose(); }
    };
    (document.body||document.documentElement).appendChild(bar);
    if (document.body) document.body.style.paddingTop = (TOP + H) + 'px';
  }

  // 登录成功后把顶栏文案改为"已登录 · 点击返回"
  function __ndUpdateLabel(){
    if (window.__ND_NATIVE_BAR) return;
    try {
      if (window.__ND_TOKEN && !window.__ND_LABELED) {
        var c = document.querySelector('#__nd_bar .nd-center');
        if (c) { c.textContent = '已登录 · 点击返回'; window.__ND_LABELED = true; }
      }
    } catch(e){}
  }

  // 每秒：确保顶栏在；更新标签；抓 token（仅暂存 window.__ND_TOKEN，不自动跳回）。
  // Rust 侧定时重注入本脚本（扛整页跳转），window.__ND_INTERVAL 防同文档重复注册定时器。
  if (!window.__ND_INTERVAL) {
    window.__ND_INTERVAL = setInterval(function(){
      try { if (!window.__ND_NATIVE_BAR) __ndEnsureBar(); } catch(e){}
      try { if (!window.__ND_NATIVE_BAR) __ndUpdateLabel(); } catch(e){}
      if (window.__ND_DONE) return;
      var t = '';
      try { t = __ND_GETTER(); } catch(e){ t = ''; }
      if (t) {
        try { window.__ND_TOKEN = t; } catch(e){}
        // 原生模式：把抓到的 token 上报给原生层（用于顶栏文案 + 返回时回传主 App）
        if (window.NetdiskBridge && !window.__ND_NOTIFIED) {
          window.__ND_NOTIFIED = true;
          try { window.NetdiskBridge.onTokenCaptured(t); } catch(e){}
        }
      }
    }, 1000);
  }
  // 立即先来一次（页面已就绪时）
  try { if (!window.__ND_NATIVE_BAR) __ndEnsureBar(); } catch(e){}
})();`;
}
