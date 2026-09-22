// hls.js 封装：让 Chromium WebView（Windows/Linux/Android）也能播放 m3u8
// - 原生支持 HLS 的浏览器（Safari/iOS）走 video.src
// - 其余走 hls.js，并透传防盗链 headers
// 注意：hls.js 改为动态 import（应用启动不加载），规避 1.6.17 的模块初始化循环依赖崩溃问题。

import { invoke } from '@tauri-apps/api/core';
import { devError, devWarn } from './log';
import { isTauri } from './tauriBridge';

type HlsOpts = {
  headers?: Record<string, string>;
  onError?: (fatal: boolean) => void;
};

// ===== V3.6.5：本地流式媒体代理 =====
// 点播/直播的所有媒体请求经 127.0.0.1 临时端口的 Rust 流式代理（见 lib.rs media_proxy_port /
// serve_proxy），彻底去掉旧 fetchmedia 的 base64 全量过桥。hls.js 可边下边播、正常预取，
// mp4 支持 Range 拖动；防盗链头由 proxy 的 query 参数携带。
let proxyPort: number | null = null;
let proxyPortResolving: Promise<number | null> | null = null;

export async function ensureProxyPort(): Promise<number | null> {
  if (proxyPort !== null) return proxyPort;
  if (!isTauri()) return null;
  if (!proxyPortResolving) {
    proxyPortResolving = invoke<number>('media_proxy_port')
      .then((p) => {
        proxyPort = p;
        return p;
      })
      .catch(() => {
        proxyPort = null;
        return null;
      });
  }
  return proxyPortResolving;
}

// 把真实媒体 URL 改写为本地代理地址；代理不可用（非 Tauri / 端口未就绪）时原样返回。
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

// 工厂：闭包捕获 extraHeaders，适配 hls.js 用无参 `new loader()` 实例化 Loader 的约束。
// 同一个 video 多码率切换时每个 hls 实例各自持有自己的 headers，不再依赖模块级全局变量。
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
        callbacks.onSuccess({ url: finalUrl, data, code: res.status }, this.stats, context, null);
      } catch (e: any) {
        if (this.stats.aborted) return;
        const text = String(e?.message ?? e);
        devError('[BackendLoader]', url, text);
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
