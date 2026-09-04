// v2.7.0 图片代理组件：走 Tauri fetchimage 命令（okhttp UA + 图床 referer），
// 绕过 webview 直接加载图片时的 CORS/防盗链/UA 检测。非 Tauri 环境回落到原生 <img>。
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const cache = new Map<string, string>();

export function ProxiedImg({ src, alt = '', className, fallbackText }: { src?: string; alt?: string; className?: string; fallbackText?: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!src) {
      setDataUrl(null);
      setFailed(false);
      return;
    }
    const cached = cache.get(src);
    if (cached) {
      setDataUrl(cached);
      return;
    }
    let alive = true;
    // 非 Tauri（web 本地调试）直接原生加载
    const tryNative = () => {
      if (!alive) return;
      setFailed(true);
    };
    // ⑮ 失败重试一次（部分图床偶发超时），仍失败回落原生 <img>
    const load = (retry: boolean): Promise<void> =>
      invoke<string>('fetchimage', { url: src })
        .then((d) => {
          if (!alive) return;
          cache.set(src, d);
          setDataUrl(d);
        })
        .catch(() => {
          if (retry && alive) return load(false);
          tryNative();
        });
    load(true);
    return () => {
      alive = false;
    };
  }, [src]);

  if (!src) return null;
  if (failed) {
    // V3.2.5 #4：封面加载失败兜底改为“渐变 + 完整标题”文字卡，
    // 个别图床挂了也像有设计感的卡片，而非原先的“2 字破块”。
    return (
      <div
        className={className ? `${className} img-fallback` : 'img-fallback'}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '10px', background: 'linear-gradient(135deg,#2b2b3e,#3a2747)', color: 'rgba(255,255,255,.85)', fontWeight: 700, fontSize: '14px', lineHeight: 1.35, textAlign: 'center', letterSpacing: '0.3px', userSelect: 'none', overflow: 'hidden' }}
      >
        {fallbackText || ''}
      </div>
    );
  }
  if (!dataUrl) {
    // V3.2.5 #3：加载中显示渐变占位，避免直接渲染原始图 URL 被防盗链/CORS 拦截导致闪烁
    return (
      <div
        className={className ? `${className} img-loading` : 'img-loading'}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#23232f,#33334a)' }}
      />
    );
  }
  return <img src={dataUrl} alt={alt} className={className} loading="lazy" />;
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
