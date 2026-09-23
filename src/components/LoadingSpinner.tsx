// V3.6.6 B：通用加载动画（扩散涟漪）。
//
// 结构：3 个同心圆依次向外扩散 + 中心渐变光点呼吸。
// 用户从 4 个方案（环形转圈 / 三点脉冲 / 扩散涟漪 / 品牌字+进度条）中选定本方案——
// 品牌感最强、视觉有质感，且加载动画无需像骨架屏那样逐页量尺寸，一个组件可全局复用。
//
// 实现要点（三个坑）：
//   ① 全部用 CSS 动画：跑在合成层、不占主线程，App 卡顿时动画也不停顿；
//   ② 颜色走 --accent / --accent2 变量：深浅色主题自动跟随；
//   ③ 最小显示时长需调用方配合（见 Home.tsx 的 MIN_LOADING_MS）：数据秒回时动画一闪而过
//      会像「抖了一下」，比不显示更难受，故至少完整播一个节拍。

export function LoadingSpinner({
  label = '加载中…',
  minHeight,
  size = 52,
}: {
  label?: string;
  minHeight?: number | string;
  size?: number;
}) {
  return (
    <div
      className="loading-ripple-wrap"
      style={minHeight != null ? { minHeight } : undefined}
      role="status"
      aria-live="polite"
    >
      <div className="loading-ripple" style={{ width: size, height: size }}>
        <span />
        <span />
        <span />
        <div className="core" />
      </div>
      {label && <div className="loading-ripple-label">{label}</div>}
    </div>
  );
}
