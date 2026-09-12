import { useCallback, useRef } from 'react';

// V3.4.4 #1：与播放页进度条（.player-card .bottom .bar → .fill / .knob）完全同款的滑动条，
// 用来替换原生 <input type="range">。
//
// 为什么要换实现而不是继续调 CSS：
//   原生 range 的轨道粗细由 WebView 决定，实测默认渲染 16px；给它加的 height:4px /
//   ::-webkit-slider-runnable-track 在桌面浏览器有效，在 Android WebView 不生效（V3.4.0~V3.4.3
//   连续四版都在给这个不受控的控件打补丁，全部无效）。
//   改成自己画的 div：轨道 3px 写死、圆点 absolute 不占高度 —— 任何设备、任何 WebView 都是这个粗细，
//   与播放页进度条逐像素一致。
export function RangeBar({
  min,
  max,
  step = 1,
  value,
  onChange,
  className = '',
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const pct = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;

  const setFromX = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const raw = min + ratio * (max - min);
      const snapped = Math.round(raw / step) * step;
      // 浮点修正：step 为 5/10 时 Math.round 可能给出 79.999999 → toFixed 再转数字
      const next = Math.max(min, Math.min(max, Number(snapped.toFixed(4))));
      onChange(next);
    },
    [min, max, step, onChange],
  );

  return (
    <div
      ref={ref}
      className={'dm-bar ' + className}
      style={{ touchAction: 'none' }}
      onPointerDown={(e) => {
        try {
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        setFromX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons) setFromX(e.clientX);
      }}
      role="slider"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div className="fill" style={{ width: `${pct}%` }} />
      <div className="knob" style={{ left: `${pct}%` }} />
    </div>
  );
}
