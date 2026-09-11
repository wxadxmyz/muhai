// v2.7.0 图片代理组件：走 Tauri fetchimage 命令（okhttp UA + 图床 referer），
// 绕过 webview 直接加载图片时的 CORS/防盗链/UA 检测。非 Tauri 环境回落到原生 <img>。
//
// V3.3.1 Q2：补上「代理失败 → 原生再试 → 才认输」的三级链路。
//   旧实现里 failed 一置位就直接渲染渐变卡，注释声称的"回落原生 <img>"其实没做，
//   于是只要代理取图失败（图床域名在用户网络不可达时很常见），整屏就是一片纯渐变。
//   代理与 webview 原生的 UA / Referer / 网络栈三者都不同，图床常常只拦其中一个。
//
// V3.3.1 #5：① 并发上限 6 —— 一屏二十多张封面同时开二十多个 Rust 请求会互相抢带宽，
//   排队反而更快出图；② 滑出屏幕的图不加载（IntersectionObserver），列表快速滑动时
//   不再为看不见的封面白等超时。
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';

// V3.3.5 A1：占位文字在宿主框内按 3 行截断——110×150 的小海报框放不下的长片名不再溢出框外
const clampStyle: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  wordBreak: 'break-word',
  maxWidth: '100%',
};

const cache = new Map<string, string>();

// ── 并发限流（模块级信号量）──
const MAX_CONCURRENT = 6;
let running = 0;
const waiting: (() => void)[] = [];

function enqueue(task: () => Promise<void>) {
  const done = () => {
    running--;
    const next = waiting.shift();
    if (next) next();
  };
  const start = () => {
    running++;
    task().finally(done);
  };
  if (running < MAX_CONCURRENT) start();
  else waiting.push(start);
}

export function ProxiedImg({ src, alt = '', className, fallbackText, onFinalFail }: { src?: string; alt?: string; className?: string; fallbackText?: string; onFinalFail?: () => void }) {
  // V3.3.0 #6：useState 惰性初始化直接读模块级 cache——缓存命中时首帧渲染就是真图，
  // 不再出现"先渐变占位一帧再变图"的闪烁（useEffect 在首次绘制之后才跑，靠它恢复必闪）。
  const [dataUrl, setDataUrl] = useState<string | null>(() => (src ? cache.get(src) ?? null : null));
  const [proxyFailed, setProxyFailed] = useState(false); // 代理取图失败 → 转由 webview 原生加载
  const [nativeFailed, setNativeFailed] = useState(false); // 原生也失败 → 才是真失败
  const [visible, setVisible] = useState(false); // #5：进入过视口才加载
  const holderRef = useRef<HTMLDivElement | null>(null);
  // V3.3.5 B4：代理与原生两级都失败后的对外回调（供播放页触发跨源封面回退）。
  // 回调经 ref 转发，避免调用方传内联箭头函数导致 effect 反复触发。
  const failCb = useRef(onFinalFail);
  failCb.current = onFinalFail;
  useEffect(() => {
    if (nativeFailed) failCb.current?.();
  }, [nativeFailed]);

  // #5：视口观察——占位块露出来（含上下 200px 预取）才开始取图
  useEffect(() => {
    if (!src || dataUrl) return;
    const el = holderRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true); // 老 WebView 没有 IO：退化为立即加载
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [src, dataUrl]);

  useEffect(() => {
    if (!src || !visible || dataUrl) return;
    const cached = cache.get(src);
    if (cached) {
      setDataUrl(cached);
      return;
    }
    let alive = true;
    // Q2：代理只跑一次，失败立刻转原生。超时已收到 8s，重试一次就是 16s，
    // 一屏十几张图会长时间停在渐变占位，看上去像"根本没有封面"。
    enqueue(() =>
      invoke<string>('fetchimage', { url: src })
        .then((d) => {
          if (!alive) return;
          cache.set(src, d);
          setDataUrl(d);
        })
        .catch(() => {
          if (alive) setProxyFailed(true);
        })
    );
    return () => {
      alive = false;
    };
  }, [src, visible, dataUrl]);

  if (!src) return null;

  if (dataUrl) return <img src={dataUrl} alt={alt} className={className} loading="lazy" />;

  // 代理没拿到 → 让 webview 自己直接加载一次（UA/Referer 与代理不同，未必一起失败）
  if (proxyFailed && !nativeFailed) {
    return (
      <img
        src={src}
        alt={alt}
        className={className}
        loading="lazy"
        onError={() => setNativeFailed(true)}
      />
    );
  }

  // 真失败：渐变 + 完整标题的文字卡（V3.2.5 #4 的设计），个别图床挂了也像有设计感的卡片。
  // Q2：调用方务必传 fallbackText，否则这里就是一块没有字的渐变（看不出是失败还是没图）。
  if (nativeFailed) {
    return (
      <div
        className={className ? `${className} img-fallback` : 'img-fallback'}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '10px', background: 'linear-gradient(135deg,#2b2b3e,#3a2747)', color: 'rgba(255,255,255,.85)', fontWeight: 700, fontSize: '14px', lineHeight: 1.35, textAlign: 'center', letterSpacing: '0.3px', userSelect: 'none', overflow: 'hidden' }}
      >
        {/* V3.3.5 A1：片名过长时在 110×150 小海报框内截断为 3 行，不再溢出框外 */}
        <span style={clampStyle}>{fallbackText || ''}</span>
      </div>
    );
  }

  // 加载中占位（#5：ref 挂在这里做视口观察）。
  // V3.3.2 #3：占位即显示片名文字，不再是一块纯空白渐变——
  // 封面 URL 失效/慢时，用户至少能立刻看到片名而不是"深紫空白"。
  return (
    <div
      ref={holderRef}
      className={className ? `${className} img-loading` : 'img-loading'}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '10px', background: 'linear-gradient(135deg,#23232f,#33334a)', color: 'rgba(255,255,255,.82)', fontWeight: 700, fontSize: '14px', lineHeight: 1.35, textAlign: 'center', overflow: 'hidden', userSelect: 'none' }}
    >
      {/* V3.3.5 A1：同上，小海报框内 3 行截断 */}
      <span style={clampStyle}>{fallbackText || ''}</span>
    </div>
  );
}

// ⑪ 暴露给设置页「清除缓存」：清空 base64 图片缓存
export function clearProxiedCache() {
  cache.clear();
}
// ⑪ 暴露给设置页：估算 base64 图片缓存占用的字节数（用于副标题实时显示缓存大小）
export function proxiedCacheBytes(): number {
  let n = 0;
  cache.forEach((v) => { n += v.length; });
  return n;
}
