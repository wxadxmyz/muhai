import { ReactNode, CSSProperties } from 'react';

// 统一线性图标集（Lucide 风格，stroke=currentColor，随主题色与字号自适应）。
// 用于替换界面原有 emoji，消除深色背景发虚、风格不统一的问题。

const P: Record<string, ReactNode> = {
  home: <path d="M3 11.5 12 4l9 7.5" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  film: <><rect x="3" y="3" width="18" height="18" rx="2.5" /><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" /></>,
  music: <><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>,
  library: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20" /></>,
  plug: <><path d="M9 2v6M15 2v6" /><path d="M7 8h10v3a5 5 0 0 1-10 0z" /><path d="M12 16v6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  heart: <path d="M12 21s-7-4.6-9.5-9A5 5 0 0 1 12 6a5 5 0 0 1 9.5 6c-2.5 4.4-9.5 9-9.5 9z" />,
  'heart-filled': <path d="M12 21s-7-4.6-9.5-9A5 5 0 0 1 12 6a5 5 0 0 1 9.5 6c-2.5 4.4-9.5 9-9.5 9z" fill="currentColor" />,
  volume: <><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16 9a4 4 0 0 1 0 6" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></>,
  maximize: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-left': <path d="M15 6l-6 6 6 6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  // 竖排三点菜单（⋮）
  more: <><circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" /></>,
  'arrow-left': <><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></>,
  'arrow-right': <><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></>,
  'arrow-up': <><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></>,
  'arrow-down': <><path d="M12 5v14" /><path d="M19 12l-7 7-7-7" /></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
  repeat: <><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>,
  'repeat-one': <><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /><text x="12" y="15" fontSize="9" fontWeight="700" textAnchor="middle" stroke="none" fill="currentColor">1</text></>,
  shuffle: <path d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7M21 16v5h-5M14 14l7 7M3 8V3h5M10 10L3 3" />,
  bug: <><rect x="8" y="6" width="8" height="14" rx="4" /><path d="M12 2v4M5 10h14M5 14h14M8 6l-2-2M16 6l2-2M6 18l-2 2M18 18l2 2" /></>,
  download: <><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M5 21h14" /></>,
  cast: <><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2" /><path d="M2 12a10 10 0 0 1 10 10" /><path d="M2 16a6 6 0 0 1 6 6" /></>,
  // 投屏：电视图标（对齐设计文件 i-tv）
  tv: <><rect x="3" y="5" width="18" height="13" rx="2" /><path d="M8 21h8M12 18v3" /></>,
  captions: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M7 12h3M14 12h3M7 15h2M13 15h4" /></>,
  'file-text': <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18 2 2 0 0 0 2-2 2 2 0 0 1 2-2h1a4 4 0 0 0 4-4 9 9 0 0 0-9-9z" /><circle cx="8" cy="11" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="16" cy="11" r="1" fill="currentColor" stroke="none" /></>,
  camera: <><path d="M3 7h4l2-3h6l2 3h4v13H3z" /><circle cx="12" cy="13" r="4" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5 13l4 4L19 7" />,
  'x-circle': <><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  file: <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />,
  message: <><path d="M21 11.5a8.5 8.5 0 0 1-12.2 7.7L3 21l1.8-5.8A8.5 8.5 0 1 1 21 11.5z" /></>,
  'fast-forward': <><path d="M4 5l8 7-8 7z" fill="currentColor" /><path d="M13 5l8 7-8 7z" fill="currentColor" /></>,
  pip: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor" stroke="none" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  sliders: <><path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="13" cy="17" r="2" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  'lock-open': <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0" /></>,
  // 横屏 / 竖屏切换（rotate 设备方向）
  rotate: <><path d="M4 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" /><path d="M16 12h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4" /></>,
  'rotate-portrait': <><path d="M8 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /><path d="M4 8v8a2 2 0 0 0 2 2h2" /></>,
  refresh: <><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 4v4h-4" /></>,
  replay: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>,
  sparkles: <><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" /><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z" /></>,
  battery: <><rect x="2" y="8" width="17" height="9" rx="2" /><path d="M22 11v3" /></>,
  // 填充型（播放/暂停/上一首/下一首）：在小圆按钮里更醒目
  play: <path d="M7 4.5v15l13-7.5z" fill="currentColor" />,
  pause: <g fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2" /><rect x="14" y="5" width="4" height="14" rx="1.2" /></g>,
  'skip-back': <><path d="M19 5v14l-9-7z" fill="currentColor" /><rect x="5" y="5" width="2.4" height="14" fill="currentColor" rx="1" /></>,
  'skip-forward': <><path d="M5 5v14l9-7z" fill="currentColor" /><rect x="16.6" y="5" width="2.4" height="14" fill="currentColor" rx="1" /></>,
  // 上一集 / 下一集（对齐设计文件 i-prev / i-next：竖线 + 三角）
  prev: <><path d="M19 5v14" /><path d="M5 12l9-7v14z" fill="currentColor" stroke="none" /></>,
  next: <><path d="M5 5v14" /><path d="M19 12l-9-7v14z" fill="currentColor" stroke="none" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof P;

// v3.0.5 A 组：图标「视觉居中」补偿表（单位 = 24×24 viewBox 的 1 格）
// ---------------------------------------------------------------------------
// 为什么需要：这些图标放进圆形按钮后肉眼可见地偏离圆心，但父容器的 flex/grid 居中
// 并没有失效 —— 真正的原因是 path 自身在画布里就没居中。两种情况：
//   1) 包围盒偏心：图形只占画布的一部分，bbox 中心 ≠ (12,12)（如 tv 底座只在下方）
//   2) 笔画质心偏心：bbox 虽然居中，但笔画疏密不均（如 arrow-left 箭头端三笔、
//      线尾只有一笔，质心被拉向箭头；lock 的锁体是 14×9 重矩形、锁梁只是细半弧）
// 做法：渲染时整体平移，把视觉质心拉回 (12,12)。只做平移，不改变图标形状与线宽。
// 数值来源：按各 path 的笔画长度加权算质心，再取 60%~80% 补偿量（补偿满会显得贴边）。
const OPTICAL: Partial<Record<IconName, [number, number]>> = {
  // 箭头端笔画密 → 质心 x≈10.3，右移补回
  'arrow-left': [1.2, 0],
  'arrow-right': [-1.2, 0],
  // 锁体（y 11~20，周长 46）远重于锁梁（半弧，长 12.6）→ 质心 y≈13.5，上移补回
  lock: [0, -1.2],
  'lock-open': [0, -1.2],
  // 气泡尾巴在左下 → 质心被拽向左下
  message: [0.5, -0.3],
  // 机身 y 5~18 居中，但底座（y 18~21）只在下方 → bbox 中心 y=13
  tv: [0, -0.8],
  // 投屏弧线集中在右下 → 质心偏下
  cast: [0, -0.8],
  // 主设备框 y 6~20（中心 13），右侧凸起只在中下部 → 质心 y≈13.4
  rotate: [0, -1.2],
};

export function Icon({ name, size = 22, className, strokeWidth = 1.9, style }: { name: IconName; size?: number; className?: string; strokeWidth?: number; style?: CSSProperties }) {
  const off = OPTICAL[name];
  const glyph = off && (off[0] !== 0 || off[1] !== 0)
    ? <g transform={`translate(${off[0]} ${off[1]})`}>{P[name]}</g>
    : P[name];
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', margin: 'auto', ...style }}
    >
      {glyph}
    </svg>
  );
}
