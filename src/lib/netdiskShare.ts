// V3.7.5 #4：网盘分享源自动解析 4K。
//
// 背景：玩偶哥哥 / 肥猫 等 csp 爬虫源在 play() 阶段返回的是「网盘分享链接」
//（aliyundrive.com/s/xxx、pan.quark.cn/s/xxx），而非可直链 m3u8/mp4。影视仓之所以能播 4K，
// 是因为内置了「分享链接 + 已登录 TOKEN → 直链」解析引擎。muhai 已有网盘登录（token 自动抓取
// 存入 store），本模块补齐缺失的解析层，让这类源也能出直链。
//
// 解析流程（以阿里云盘为例）：
//   分享短链 → 提取 share_id → 用 refresh_token 换 access_token → get_share_token →
//   列根目录找视频文件 → get_download_url 拿直链 → 交给播放器（经本地代理防 CORS/Range）。
//
// 调用方（drpy3.ts getPlayUrl）：play() 返回 URL 若命中网盘分享链接，先走本模块解析；
// 解析成功且得到直链则替换，失败则回退原行为（由 guardPlayable 报「网页不可播」）。
//
// 说明：本模块只做通用解析，不依赖任何具体源配置；最终能否出 4K 取决于源提供的分享内容。

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauriBridge';
import { getAllNetdiskTokens, type NetdiskKey } from './netdisk';

// V4.5.4：网盘解析 API 经 Rust fetchmedia 过桥——WebView 直连阿里/夸克 API 会被 CORS 拦，
// 且 Android 明文/证书策略也会挡。走原生代理与 netdisk.ts 的文件浏览同一通道。
async function apiFetch(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<any> {
  if (!isTauri()) {
    const r = await fetch(url, { method: 'POST', headers, body });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  const res = await invoke<{ data: string; url: string }>('fetchmedia', { url, headers, body });
  return JSON.parse(atob(res.data));
}

export type NetdiskShare = {
  provider: NetdiskKey;
  shareId: string;
  pwd?: string;
};

/** 识别是否为网盘分享链接，并提取 provider + shareId */
export function parseNetdiskShare(url: string): NetdiskShare | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    // 阿里云盘：https://www.aliyundrive.com/s/<shareId> 或 https://aliyundrive.com/s/<shareId>
    if (h === 'www.aliyundrive.com' || h === 'aliyundrive.com') {
      const m = u.pathname.match(/^\/s\/([^/?#]+)/i);
      if (m) return { provider: 'ali', shareId: m[1], pwd: u.searchParams.get('pwd') ?? undefined };
    }
    // 夸克网盘：https://pan.quark.cn/s/<shareId>
    if (h === 'pan.quark.cn') {
      const m = u.pathname.match(/^\/s\/([^/?#]+)/i);
      if (m) return { provider: 'quark', shareId: m[1], pwd: u.searchParams.get('pwd') ?? undefined };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function isNetdiskShare(url: string): boolean {
  return parseNetdiskShare(url) != null;
}

// ---- 阿里云盘 ----

interface AliTokens {
  accessToken: string;
}

async function aliRefreshToken(refreshToken: string): Promise<string> {
  const j = await apiFetch(
    'https://auth.aliyundrive.com/v2/account/token',
    { 'Content-Type': 'application/json' },
    JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken })
  );
  if (!j?.access_token) throw new Error('阿里未返回 access_token');
  return j.access_token as string;
}

async function aliResolve(share: NetdiskShare): Promise<string | null> {
  const stored = getAllNetdiskTokens().ali;
  if (!stored) throw new Error('未登录阿里云盘，无法解析分享链接');
  // V4.1.6 ④：localStorage 'token' 存的是完整 JSON（含 access_token/refresh_token），
  // 之前误把整段 JSON 当 refresh_token 去刷新必然失败。这里先解析取 refresh_token
  // （没有则退而取 access_token），再刷新成可用的 access_token。
  let refreshToken = stored;
  try {
    const j = JSON.parse(stored);
    if (j && typeof j.refresh_token === 'string' && j.refresh_token) refreshToken = j.refresh_token;
    else if (j && typeof j.access_token === 'string' && j.access_token) refreshToken = j.access_token;
  } catch {
    // 存的就是裸 token（非 JSON）
  }
  let accessToken: string;
  try {
    accessToken = await aliRefreshToken(refreshToken);
  } catch {
    // 若存的本身就是 access_token（已带 Bearer 或裸），尝试直接用
    accessToken = /^eyJ/.test(refreshToken.trim()) ? refreshToken.trim() : refreshToken;
  }
  const auth = accessToken.startsWith('Bearer ') ? accessToken : 'Bearer ' + accessToken;

  // 1) 拿 share_token
  const st = await apiFetch(
    'https://api.aliyundrive.com/adrive/v2/share_link/get_share_token',
    { 'Content-Type': 'application/json', Authorization: auth },
    JSON.stringify({ share_id: share.shareId })
  );
  const shareToken: string = st?.share_token;
  if (!shareToken) throw new Error('阿里未返回 share_token');

  // 2) 列根目录文件
  const list = await apiFetch(
    'https://api.aliyundrive.com/adrive/v2/file/list_by_share',
    { 'Content-Type': 'application/json', Authorization: auth, 'x-share-token': shareToken },
    JSON.stringify({
      share_id: share.shareId,
      parent_file_id: 'root',
      limit: 100,
      order_by: 'name',
      order_direction: 'ASC',
    })
  );
  const items: any[] = list?.items ?? [];
  if (!items.length) throw new Error('阿里分享为空');

  // 3) 选视频文件：优先 m3u8，其次 mp4，再次最大体积文件
  const pick = (arr: any[]) => {
    return (
      arr.find((f) => /\.m3u8$/i.test(f.name ?? '')) ||
      arr.find((f) => /\.(mp4|mkv|ts|mov|webm)$/i.test(f.name ?? '')) ||
      arr.slice().sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]
    );
  };
  const file = pick(items);
  if (!file) throw new Error('阿里分享内找不到可播文件');

  // 4) 拿直链
  const dl = await apiFetch(
    'https://api.aliyundrive.com/v2/file/get_download_url',
    { 'Content-Type': 'application/json', Authorization: auth },
    JSON.stringify({
      share_id: share.shareId,
      file_id: file.file_id,
      share_token: shareToken,
    })
  );
  const url: string | undefined = dl?.url;
  return url ?? null;
}

// ---- 夸克网盘（best-effort，依赖 cookie 鉴权，格式随官方变动较大）----

async function quarkResolve(share: NetdiskShare): Promise<string | null> {
  const cookie = getAllNetdiskTokens().quark;
  if (!cookie) throw new Error('未登录夸克网盘，无法解析分享链接');
  const headers = {
    'Content-Type': 'application/json',
    cookie: typeof cookie === 'string' ? cookie : '',
  };
  // 1) 分享页 token：拿到 stoken / share_fid_token
  const tk = await apiFetch(
    'https://drive-pc.quark.cn/1.0/open/api/share/sharepage/token',
    headers,
    JSON.stringify({ pwd_id: share.shareId, passcode: share.pwd ?? '' })
  );
  const stoken: string = tk?.data?.stoken;
  const shareFidToken: string = tk?.data?.share_fid_token;
  const firstPid = tk?.data?.first_file_info?.fid ?? '0';
  if (!stoken) throw new Error('夸克未返回 stoken');

  // 2) 列文件
  const lj = await apiFetch(
    'https://drive-pc.quark.cn/1.0/open/api/share/sharepage/detail',
    headers,
    JSON.stringify({
      stoken,
      pdir_fid: firstPid,
      pcode: '',
      share_fid_token: shareFidToken,
      not_pwd: true,
    })
  );
  const items: any[] = lj?.data?.list ?? [];
  if (!items.length) throw new Error('夸克分享为空');
  const file = items.find((f) => /\.(m3u8|mp4|mkv|ts|mov|webm)$/i.test(f.file_name ?? '')) || items[0];
  if (!file) throw new Error('夸克分享内找不到可播文件');

  // 3) 直链
  const dj = await apiFetch(
    'https://drive-pc.quark.cn/1.0/open/api/file/download',
    headers,
    JSON.stringify({ fid: file.fid, stoken, share_fid_token: shareFidToken, pdir_fid: firstPid })
  );
  const url: string | undefined = dj?.data?.download_url || dj?.data?.thumbs?.[0];
  return url ?? null;
}

/** 解析网盘分享链接为可播放直链；无法解析返回 null（调用方回退原行为）。 */
export async function resolveNetdiskShare(url: string): Promise<string | null> {
  const share = parseNetdiskShare(url);
  if (!share) return null;
  if (share.provider === 'ali') return aliResolve(share);
  if (share.provider === 'quark') return quarkResolve(share);
  // UC 暂未实现（其分享解析官方接口不公开），返回 null 走原报错路径
  return null;
}
