// V3.3.0 #1/#2/#4/#5：网格卡片尺寸 JS 实测。
// 根因：该真机 WebView 对 flex 内 calc(100% - Xpx) 与 flex item 上的 aspect-ratio 解析不可靠
// （真机实测：设定卡宽 118.7px/缝 2px，实际渲染 96px/25px；更多页卡片被 align-items:stretch
// 拉到整屏高）。改由 JS 实测容器宽度，直接输出 px 卡宽/卡高内联到每个卡片——
// 不再依赖任何会被解析错的 CSS 单位，WebView 想错都没有空间。
// 比例统一 3:4（V3.3.0：用户要求"矮一点"，比原 2:3 矮约 11%）。
import { useCallback, useRef, useState } from 'react';

export function useCardGrid(opts: { cols: number; gap: number; pad?: number; mode?: 'grid' | 'row' }) {
  const { cols, gap, pad = 0, mode = 'grid' } = opts;
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

  // V3.3.1 Q1：两种排布各算各的可用宽——
  //   grid（更多页/网格）：两侧都留边，扣 pad*2 + (cols-1) 个缝。
  //   row（主页横排）：只扣左侧边 + cols 个缝（比 grid 多扣一个缝）。
  //     多扣的这一个缝是关键：第 cols+1 张卡的左边缘 = pad + cols*cardW + cols*gap
  //     = pad + inner + cols*gap…… 令 inner = width - pad - cols*gap，则该值恰好 = width，
  //     即第 cols+1 张卡的左边缘正好压在屏幕右边界上——屏幕里只见 cols 张，
  //     第 cols+1 张必须滑动才出现（旧公式两侧都留边，右留的 10px 装不下 8px 的缝，
  //     导致第 4 张卡探进屏幕 2px，就是反馈里"露个边"的那 2px）。
  const inner =
    mode === 'row'
      ? Math.max(width - pad - gap * cols, 0)
      : Math.max(width - pad * 2 - gap * (cols - 1), 0);
  // V3.3.1 Q1：不再 Math.floor——取整丢掉的余数会让第 cols+1 张卡最多再露出 ~2px。
  // 保留两位小数，cols 张卡加缝仍精确等于 inner，不累积误差。
  const cardW = inner > 0 ? Math.round((inner / cols) * 100) / 100 : 0;
  const cardH = cardW > 0 ? Math.round((cardW * 4) / 3) : 0; // 3:4
  return { ref, ready: cardW > 0, cardW, cardH };
}
