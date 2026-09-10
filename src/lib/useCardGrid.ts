// V3.3.0 #1/#2/#4/#5：网格卡片尺寸 JS 实测。
// 根因：该真机 WebView 对 flex 内 calc(100% - Xpx) 与 flex item 上的 aspect-ratio 解析不可靠
// （真机实测：设定卡宽 118.7px/缝 2px，实际渲染 96px/25px；更多页卡片被 align-items:stretch
// 拉到整屏高）。改由 JS 实测容器宽度，直接输出 px 卡宽/卡高内联到每个卡片——
// 不再依赖任何会被解析错的 CSS 单位，WebView 想错都没有空间。
// 比例统一 3:4（V3.3.0：用户要求"矮一点"，比原 2:3 矮约 11%）。
import { useCallback, useRef, useState } from 'react';

export function useCardGrid(opts: { cols: number; gap: number; pad?: number }) {
  const { cols, gap, pad = 0 } = opts;
  const [width, setWidth] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);
  const elRef = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const el = elRef.current;
    if (el) setWidth(el.clientWidth);
  }, []);

  // callback ref：DOM 真实挂载时才测量（比 useEffect 靠谱，不怕条件渲染晚挂载）
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      try { roRef.current?.disconnect(); } catch { /* ignore */ }
      roRef.current = null;
      elRef.current = el;
      if (el) {
        setWidth(el.clientWidth);
        try {
          const ro = new ResizeObserver(measure);
          ro.observe(el);
          roRef.current = ro;
        } catch { /* 老 WebView 无 ResizeObserver：保持首测值 */ }
      }
    },
    [measure]
  );

  // clientWidth 含容器左右 padding（pad 由容器内联样式设置），扣掉得到内容区
  const inner = Math.max(width - pad * 2 - gap * (cols - 1), 0);
  const cardW = inner > 0 ? Math.floor(inner / cols) : 0;
  const cardH = cardW > 0 ? Math.round((cardW * 4) / 3) : 0; // 3:4
  return { ref, ready: cardW > 0, cardW, cardH };
}
