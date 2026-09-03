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
    loginUrl: 'https://www.aliyundrive.com/',
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
    loginUrl: 'https://pc.uc.cn/',
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
}

/** 启动时调用：把已存 token 挂到 window，供 spider 引擎读取 */
export function syncNetdiskTokens() {
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
