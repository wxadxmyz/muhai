/**
 * A8：safe-area 兜底
 *
 * 背景：styles.css 里 --sat 写作 env(safe-area-inset-top, 26px)，但 env() 的 fallback
 * 只在「变量未定义」时才生效。APP 走沉浸式全屏（MuHaiAndroid.immersive），相当一部分
 * WebView 会明确上报 safe-area-inset-top: 0px —— 那一瞬间 --sat 变成 0，所有顶部安全区
 * padding 全部失效，历史/收藏页的卡片上滑时会一路滚进通知栏区域。
 *
 * 对策：启动时用一个探针元素实测真实 inset，低于阈值就覆盖成一个经验值。
 * 直接把 --sat/--sab 写成确定 px（内联样式优先级高于样式表，也高于 @supports 分支），
 * 不再依赖 max()/env() 在卓易通等 WebView 上的支持度。
 */

const MIN_TOP = 24; // 低于此高度认为 WebView 没上报（安卓状态栏典型 24~32dp）
const FALLBACK_TOP = 28;
const MIN_BOTTOM = 8;
const FALLBACK_BOTTOM = 12;

function measure(varExpr: string): number {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  // 用 padding-top 而不是 height 承载 env()：padding 上的 env() 支持面最广。
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    `padding-top:${varExpr};`;
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h || 0;
}

function sync(): void {
  const root = document.documentElement;
  const top = measure('env(safe-area-inset-top, 0px)');
  root.style.setProperty('--sat', `${top >= MIN_TOP ? top : FALLBACK_TOP}px`);
  const bottom = measure('env(safe-area-inset-bottom, 0px)');
  root.style.setProperty('--sab', `${bottom >= MIN_BOTTOM ? bottom : FALLBACK_BOTTOM}px`);
}

let installed = false;

/** 首次调用生效；之后监听尺寸/横竖屏变化重算（横屏 inset 与竖屏不同）。 */
export function installSafeAreaFallback(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  try {
    sync();
  } catch {
    /* ignore */
  }
  let timer: number | undefined;
  const onResize = () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      try {
        sync();
      } catch {
        /* ignore */
      }
    }, 200);
  };
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });
}
