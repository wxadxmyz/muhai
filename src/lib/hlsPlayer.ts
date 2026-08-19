// hls.js 封装：让 Chromium WebView（Windows/Linux/Android）也能播放 m3u8
// - 原生支持 HLS 的浏览器（Safari/iOS）走 video.src
// - 其余走 hls.js，并透传防盗链 headers
// 注意：hls.js 改为动态 import（应用启动不加载），规避 1.6.17 的模块初始化循环依赖崩溃问题。

type HlsOpts = {
  headers?: Record<string, string>;
  onError?: (fatal: boolean) => void;
};

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
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
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
}
