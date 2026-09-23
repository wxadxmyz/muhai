// hls.js 封装：让 Chromium WebView（Windows/Linux/Android）也能播放 m3u8
// - 原生支持 HLS 的浏览器（Safari/iOS）走 video.src
// - 其余走 hls.js，并透传防盗链 headers
// 注意：hls.js 改为动态 import（应用启动不加载），规避 1.6.17 的模块初始化循环依赖崩溃问题。

import { invoke } from '@tauri-apps/api/core';
import { devError, devWarn } from './log';
import { isTauri } from './tauriBridge';
import { getSettings } from './settings';
import { markMedia } from './mediaProbe';

type HlsOpts = {
  headers?: Record<string, string>;
  onError?: (fatal: boolean) => void;
};

// ===== V3.6.5：本地流式媒体代理 =====
// 点播/直播的所有媒体请求经 127.0.0.1 临时端口的 Rust 流式代理（见 lib.rs media_proxy_port /
// serve_proxy），彻底去掉旧 fetchmedia 的 base64 全量过桥。hls.js 可边下边播、正常预取，
// mp4 支持 Range 拖动；防盗链头由 proxy 的 query 参数携带。
//
// V3.6.8：代理改为「可关闭」。设置里的 useMediaProxy 关掉后走旧的 fetchmedia 全量过桥，
// 供部分 ROM/WebView 上回环明文访问不通时自救，也供 A/B 对照排查。
let proxyPort: number | null = null;
let proxyPortResolving: Promise<number | null> | null = null;

/** 代理是否启用（读当前设置）。非 Tauri 环境恒为 false。 */
export function proxyEnabled(): boolean {
  if (!isTauri()) return false;
  try {
    return getSettings().useMediaProxy !== false;
  } catch {
    return true; // 读不到设置时按默认开
  }
}

export async function ensureProxyPort(): Promise<number | null> {
  if (!proxyEnabled()) return null;
  if (proxyPort !== null) return proxyPort;
  if (!proxyPortResolving) {
    proxyPortResolving = invoke<number>('media_proxy_port')
      .then((p) => {
        proxyPort = p;
        markMedia('ok', '代理端口', `已就绪 127.0.0.1:${p}`);
        return p;
      })
      .catch((e: any) => {
        proxyPort = null;
        // 端口拿不到 = 后面 buildProxyUrl 会原样返回上游地址 → 直连 → CORS/Range 全暴露。
        // 这是真机转圈的头号嫌疑，必须显式记下来。
        markMedia('fail', '代理端口', `获取失败：${e?.message ?? e}（将回退直连）`);
        return null;
      });
  }
  return proxyPortResolving;
}

/** 重置端口缓存（用户切换 useMediaProxy 开关后调用，让下次播放重新走对应链路）。 */
export function resetProxyPort(): void {
  proxyPort = null;
  proxyPortResolving = null;
}

// 把真实媒体 URL 改写为本地代理地址；代理不可用（非 Tauri / 端口未就绪 / 用户关闭）时原样返回。
export function buildProxyUrl(url: string, headers?: Record<string, string> | null): string {
  if (!isTauri() || proxyPort == null) return url;
  const u = new URL(`http://127.0.0.1:${proxyPort}/proxy`);
  u.searchParams.set('url', url);
  if (headers?.Referer) u.searchParams.set('referer', headers.Referer);
  if (headers?.['User-Agent']) u.searchParams.set('ua', headers['User-Agent']);
  return u.toString();
}

// ===== 后端代理 Loader（点播/直播共用，V3.5.1 从 Live.tsx 抽取）=====
// 让 m3u8 主/子清单与 ts 分片都经 Rust 本地流式代理拉流，
// 既能带上防盗链/自定义头（User-Agent/Referer），又不受 WebView CORS 限制。

export function streamHeaders(url: string, extra?: Record<string, string> | null): Record<string, string> {
  let ref = '';
  try {
    ref = new URL(url).origin;
  } catch {
    /* ignore */
  }
  const base: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    Referer: ref || 'https://www.google.com',
  };
  return extra ? { ...base, ...extra } : base;
}

// V3.6.8：fetchmedia 全量过桥路径（V3.6.4 的可用实现）。
//
// 与代理路径的区别：Rust 把整段响应读进内存 → base64 → JSON 回传，前端 atob 解码。
// 没有流式预取，高码率分片会「播两秒卡一下」，但**不经过 WebView 的回环 HTTP**，
// 因此不受「Android 9+ 明文流量策略 / 回环访问异常」影响。
//
// 保留它作为代理不可用时的兜底，是本次「保证能播优先」的核心手段。
async function loadViaFetchmedia(
  url: string,
  headers: Record<string, string>,
  context: any,
  callbacks: any,
  stats: any,
  t0: number
) {
  const t0b = t0 || performance.now();
  markMedia('warn', '回退过桥', `代理不可用，改用 fetchmedia：${url.slice(0, 120)}`);
  const r = (await invoke('fetchmedia', { url, headers })) as string | { data: string; url: string };
  if (stats.aborted) return;
  // 兼容两种返回：旧版纯 base64 字符串 / 新版 {data,url} JSON
  let b64 = '';
  let finalUrl = url;
  if (typeof r === 'string') {
    const s = r.trim();
    if (s.startsWith('{')) {
      const j = JSON.parse(s);
      b64 = String(j.data ?? '');
      finalUrl = String(j.url ?? url);
    } else {
      b64 = s;
    }
  } else {
    b64 = String((r as any)?.data ?? '');
    finalUrl = String((r as any)?.url ?? url);
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const isText = context.responseType === 'text' || context.responseType === '';
  const data = isText ? new TextDecoder('utf-8').decode(bytes) : bytes.buffer;
  const t1 = performance.now();
  stats.loading.first = t1;
  stats.loading.end = t1;
  stats.loaded = bytes.length;
  stats.total = bytes.length;
  stats.bwEstimate = (bytes.length * 8000) / Math.max(1, t1 - t0b);
  callbacks.onSuccess({ url: finalUrl, data, code: 200 }, stats, context, null);
}

// 工厂：闭包捕获 extraHeaders，适配 hls.js 用无参 `new loader()` 实例化 Loader 的约束。
export function createBackendLoader(extraHeaders: Record<string, string> | null = null) {
  return class BackendLoader {
    context: any = null;
    // V3.5.0 修复：stats 必须完整包含 hls.js LoaderStats 要求的 loading/parsing/buffering 三个嵌套对象。
    // 否则 hls.js 在 manifest/分片加载成功后写 stats.parsing.start / stats.buffering.start 时命中 undefined，
    // 抛 "Cannot set properties of undefined (setting 'start')"，被包装成 manifestLoadError。
    stats: any = {
      aborted: false,
      loaded: 0,
      total: 0,
      retry: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
    };
    constructor(_config?: any) {}
    async load(context: any, _config: any, callbacks: any) {
      this.context = context;
      const url = context.url;
      const headers = streamHeaders(url, extraHeaders);
      const t0 = performance.now();
      this.stats.loading.start = t0;
      // 纯 Web/dev 环境：没有 Tauri 后端（invoke 不可用），回退浏览器直连。
      // 仅对 CORS 放行的源有效（如公开测试流）；生产 APK 始终有后端，不走此分支。
      if (!isTauri()) {
        try {
          const res = await fetch(url, Object.keys(headers).length ? { headers } : undefined);
          if (this.stats.aborted) return;
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const buf = await res.arrayBuffer();
          const isText = context.responseType === 'text' || context.responseType === '';
          const data = isText ? new TextDecoder('utf-8').decode(buf) : buf;
          const t1 = performance.now();
          this.stats.loading.first = t1; this.stats.loading.end = t1;
          this.stats.loaded = buf.byteLength; this.stats.total = buf.byteLength;
          this.stats.bwEstimate = (buf.byteLength * 8000) / Math.max(1, t1 - t0);
          callbacks.onSuccess({ url, data, code: 200 }, this.stats, context, null);
        } catch (e: any) {
          if (this.stats.aborted) return;
          devError('[BackendLoader:web]', url, String(e?.message ?? e));
          callbacks.onError({ code: 0, text: String(e?.message ?? e) }, context, null, this.stats);
        }
        return;
      }
      try {
        // V3.6.5：改为走本地流式代理 —— 不再 invoke('fetchmedia') 做 base64 全量过桥，
        // 直接 fetch 127.0.0.1 代理地址，hls.js 可边下边播、预取下一分片。
        await ensureProxyPort();
        const headers = streamHeaders(url, extraHeaders);
        // V3.6.8：代理不可用（开关关闭 / 端口获取失败）→ 回退 fetchmedia 全量过桥。
        // 这是 V3.6.4 的可用路径，代价是无流式预取，但能保证「至少能播」。
        if (proxyPort == null) {
          await loadViaFetchmedia(url, headers, context, callbacks, this.stats, t0);
          return;
        }
        // hls.js 的 byte-range 请求（分段预取）透传 Range 给代理
        const rangeStart = (context as any)?.rangeStart;
        if (rangeStart != null) {
          const rangeEnd = (context as any)?.rangeEnd != null ? (context as any).rangeEnd : '';
          headers.Range = `bytes=${rangeStart}-${rangeEnd}`;
        }
        const proxied = buildProxyUrl(url, headers);
        const fetchHeaders: Record<string, string> = {};
        if (headers.Range) fetchHeaders.Range = headers.Range;
        const res = await fetch(proxied, Object.keys(fetchHeaders).length ? { headers: fetchHeaders } : undefined);
        if (this.stats.aborted) return;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await res.arrayBuffer();
        // hls.js 解析 m3u8 manifest 时要求 response.data 为 string，分片才用 ArrayBuffer
        const isText = context.responseType === 'text' || context.responseType === '';
        const data = isText ? new TextDecoder('utf-8').decode(buf) : buf;
        // 用代理回传的真实最终 URL（跟随重定向后）作为成功 URL，
        // 保证 master 里相对路径 variant 能被 hls.js 正确解析。
        const finalUrl = res.headers.get('x-proxy-final-url') || url;
        const t1 = performance.now();
        this.stats.loading.first = t1;
        this.stats.loading.end = t1;
        this.stats.loaded = buf.byteLength;
        this.stats.total = buf.byteLength;
        this.stats.bwEstimate = (this.stats.total * 8000) / Math.max(1, t1 - t0);
        // V3.6.8 埋点：只记首帧与「拿到 1 字节」这两种异常，避免每片一条把缓冲刷爆。
        // 拿到 1 字节 = Range 探测没被代理拦住 → 正是「转圈」的根因表现，必须留下证据。
        if (buf.byteLength <= 1) {
          markMedia(
            'fail',
            '疑似探测响应',
            `收到 ${buf.byteLength} 字节（Range=${headers.Range ?? '无'}）→ hls.js 将无法解析分片`
          );
        }
        callbacks.onSuccess({ url: finalUrl, data, code: res.status }, this.stats, context, null);
      } catch (e: any) {
        if (this.stats.aborted) return;
        const text = String(e?.message ?? e);
        devError('[BackendLoader]', url, text);
        markMedia('fail', '代理请求失败', `${text} · ${url.slice(0, 120)}`);
        callbacks.onError({ code: e?.code ?? 0, text }, context, null, this.stats);
      }
    }
    abort() {
      this.stats.aborted = true;
    }
    destroy() {}
  };
}

export async function peekIsHls(url: string, extra?: Record<string, string> | null): Promise<boolean> {
  try {
    const headers = streamHeaders(url, extra ?? null);
    let head = '';
    if (!isTauri()) {
      // 纯 Web/dev：浏览器直连试探前 512 字节
      const res = await fetch(url, Object.keys(headers).length ? { headers } : undefined);
      if (!res.ok) return false;
      head = (await res.text()).slice(0, 512);
    } else {
      // V3.6.5：经本地流式代理试探，避免 base64 全量过桥
      await ensureProxyPort();
      const proxied = buildProxyUrl(url, headers);
      const res = await fetch(proxied);
      if (!res.ok) return false;
      const buf = await res.arrayBuffer();
      head = new TextDecoder('utf-8').decode(buf.slice(0, 512));
    }
    return /#EXTM3U/i.test(head);
  } catch (e: any) {
    devWarn('[peekIsHls]', url, e?.message ?? e);
    return false;
  }
}

// 走后端代理挂载 HLS：主/子清单与分片统一经 Rust fetchmedia，绕开 CORS 与自定义头限制。
// onError 接收后端返回的具体错误文本（如 HTTP 404 / 防盗链拒绝），便于 UI 精准提示。
export async function attachHlsWithBackend(
  video: HTMLVideoElement,
  url: string,
  opts: { headers?: Record<string, string>; onError?: (msg?: string) => void } = {}
) {
  detachHls(video);
  if (!url) return;
  const Hls = await loadHls();
  // V3.6.5：mp4 直链直接走本地流式代理（支持 Range 拖动，且不踩 CORS），不塞给 hls.js
  if (/\.mp4(\?|$)/i.test(url) && video.canPlayType('video/mp4')) {
    await ensureProxyPort();
    video.src = proxyPort != null ? buildProxyUrl(url, opts.headers ?? null) : url;
    return;
  }
  if (!Hls || !Hls.isSupported()) {
    await ensureProxyPort();
    video.src = proxyPort != null ? buildProxyUrl(url, opts.headers ?? null) : url; // 后端不可用 / 不支持 hls.js 时回退原生尝试
    return;
  }
  await ensureProxyPort();
  const proxiedUrl = buildProxyUrl(url, opts.headers ?? null);
  const loader = createBackendLoader(opts.headers ?? null);
  const hls = new Hls({ loader, pLoader: loader });
  (video as any).__hls = hls;
  INSTANCES.set(video, hls);
  hls.loadSource(proxiedUrl);
  hls.attachMedia(video);
  // V3.6.8 埋点：记下这次用的是哪条链路 + 是否真的包到了代理地址。
  // 「包了但 manifest 加载失败」和「根本没包」是两种完全不同的病，必须能区分。
  markMedia(
    'info',
    '开始加载',
    `链路=${proxyPort != null ? `代理 127.0.0.1:${proxyPort}` : 'fetchmedia 过桥'} · ${url.slice(0, 140)}`
  );
  // V3.6.8 埋点：hls.js 的成功路径也记一条，用来给「到底卡在哪一片」定位。
  hls.on(Hls.Events.FRAG_LOADED, (_e, d: any) => {
    const st = d?.frag?.stats ?? {};
    markMedia('ok', '分片完成', `${d?.frag?.sn ?? '?'} ${d?.frag?.relurl ?? ''} ${st.loaded ?? 0} 字节`);
  });
  // Q6：fatal 错误自动恢复，但限次——避免 NETWORK_ERROR/MEDIA_ERROR 无限 startLoad/recover
  // 造成「转圈→失败→又转圈」死循环；次数耗尽后把后端错误文本交给 opts.onError，由播放页
  // 展示「重试 / 换源」入口（见 VideoPlayer 的 err 浮层），而非静默卡死。
  let netRetries = 0;
  let mediaRetries = 0;
  const MAX_NET_RETRIES = 3;
  const MAX_MEDIA_RETRIES = 3;
  hls.on(Hls.Events.ERROR, (_evt, data: any) => {
    if (!data.fatal) return;
    const backendErr =
      data.response && (data.response.text || (typeof data.response.data === 'string' ? data.response.data : ''));
    // V3.6.8 埋点：把 fatal 错误的 type/details/HTTP 状态/响应体片段全部落盘。
    // 这是判断「网络错（代理或上游有问题）」还是「解码错（数据到了但解不开）」的唯一依据。
    markMedia(
      'fail',
      `hls 致命错误 ${data.type}`,
      `details=${data.details} HTTP=${data.response?.code ?? '-'} ` +
        `reason=${data.reason ?? data.error?.message ?? '-'} ` +
        `resp=${String(backendErr ?? '').slice(0, 160)}`
    );
    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        netRetries += 1;
        if (netRetries <= MAX_NET_RETRIES) hls.startLoad();
        else opts.onError?.(backendErr || '网络错误，已自动重连多次仍失败，换个线路试试');
        break;
      case Hls.ErrorTypes.MEDIA_ERROR:
        mediaRetries += 1;
        if (mediaRetries <= MAX_MEDIA_RETRIES) hls.recoverMediaError();
        else opts.onError?.(backendErr || '解码错误，已自动恢复多次仍失败，换个线路试试');
        break;
      default:
        opts.onError?.(backendErr || data.details || data.type);
        break;
    }
  });
}

function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?.*)?$/i.test(url) || url.toLowerCase().includes('.m3u8');
}

// 动态加载 hls.js（惰性单例）：只在真正播放 m3u8 时才拉取模块
let hlsCtor: typeof import('hls.js').default | null = null;
let hlsLoading: Promise<typeof import('hls.js').default | null> | null = null;

function loadHls(): Promise<typeof import('hls.js').default | null> {
  if (hlsCtor) return Promise.resolve(hlsCtor);
  if (!hlsLoading) {
    hlsLoading = import('hls.js')
      .then((m) => {
        hlsCtor = m.default;
        return hlsCtor;
      })
      .catch(() => null);
  }
  return hlsLoading;
}

// S1：把 hls 实例也存一份到 WeakMap，供外部读写多码率档位
// （原来只挂在 video.__hls 上，模块外拿不到类型，也就没法切清晰度）
const INSTANCES = new WeakMap<HTMLVideoElement, any>();

/** 取挂在 video 上的 hls 实例；非 HLS（mp4 直链 / 原生 HLS）返回 null */
export function getHls(video: HTMLVideoElement | null | undefined): any | null {
  if (!video) return null;
  return INSTANCES.get(video) ?? null;
}

export type HlsLevel = { index: number; height: number; bitrate: number };

/** 读 m3u8 里的多码率档位列表；非 HLS 返回空数组 */
export function getLevels(video: HTMLVideoElement | null | undefined): HlsLevel[] {
  const hls = getHls(video);
  if (!hls || !Array.isArray(hls.levels)) return [];
  return hls.levels.map((l: any, i: number) => ({
    index: i,
    height: Number(l?.height) || 0,
    bitrate: Number(l?.bitrate) || 0,
  }));
}

/** 当前档位索引；-1 = 自动（ABR 自适应） */
export function getCurrentLevel(video: HTMLVideoElement | null | undefined): number {
  const hls = getHls(video);
  if (!hls) return -1;
  const v = Number(hls.currentLevel);
  return Number.isFinite(v) ? v : -1;
}

/** 切换档位；index 传 -1 表示回到自动 */
export function setLevel(video: HTMLVideoElement | null | undefined, index: number): void {
  const hls = getHls(video);
  if (!hls) return;
  try { hls.currentLevel = index; } catch { /* ignore */ }
}

// 把流挂到 video 上。自动复用/销毁旧的 hls 实例。
export async function attachHls(video: HTMLVideoElement, url: string, opts: HlsOpts = {}) {
  detachHls(video);
  if (!url) return;

  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
  if (isHlsUrl(url) && !nativeHls) {
    const Hls = await loadHls();
    if (Hls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        xhrSetup: (xhr, _u) => {
          if (opts.headers) {
            for (const [k, v] of Object.entries(opts.headers)) xhr.setRequestHeader(k, v);
          }
        },
      });
      (video as any).__hls = hls;
      INSTANCES.set(video, hls);
      hls.loadSource(url);
      hls.attachMedia(video);
      // Q6：与 attachHlsWithBackend 一致——fatal 错误限次自动恢复，避免死循环。
      let netRetries2 = 0;
      let mediaRetries2 = 0;
      const MAX_NET_RETRIES2 = 3;
      const MAX_MEDIA_RETRIES2 = 3;
      hls.on(Hls.Events.ERROR, (_evt, data: any) => {
        if (!data.fatal) return;
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            netRetries2 += 1;
            if (netRetries2 <= MAX_NET_RETRIES2) hls.startLoad();
            else opts.onError?.(true);
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            mediaRetries2 += 1;
            if (mediaRetries2 <= MAX_MEDIA_RETRIES2) hls.recoverMediaError();
            else opts.onError?.(true);
            break;
          default:
            opts.onError?.(true);
            break;
        }
      });
      return;
    }
    // hls.js 动态加载失败 / 不支持 → 回退原生尝试
  }
  // 原生 HLS（Safari）或非 HLS 直链
  video.src = url;
}

// 销毁挂在 video 上的 hls 实例，避免内存泄漏 / 多实例并存
export function detachHls(video: HTMLVideoElement | null) {
  if (!video) return;
  const hls = (video as any).__hls as { destroy(): void } | undefined;
  if (hls) {
    hls.destroy();
    (video as any).__hls = undefined;
  }
  INSTANCES.delete(video);
}
