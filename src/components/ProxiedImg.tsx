// v2.7.0 图片代理组件：走 Tauri fetchimage 命令（okhttp UA + 图床 referer），
// 绕过 webview 直接加载图片时的 CORS/防盗链/UA 检测。非 Tauri 环境回落到原生 <img>。
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const cache = new Map<string, string>();

export function ProxiedImg({ src, alt = '', className }: { src?: string; alt?: string; className?: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setDataUrl(null);
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
      setDataUrl(src);
    };
    invoke<string>('fetchimage', { url: src })
      .then((d) => {
        if (!alive) return;
        cache.set(src, d);
        setDataUrl(d);
      })
      .catch(() => tryNative());
    return () => {
      alive = false;
    };
  }, [src]);

  if (!src) return null;
  return <img src={dataUrl ?? src} alt={alt} className={className} loading="lazy" />;
}
