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
// --sab 下限：env() 没上报或上报值更小时，底部也至少留 12px 呼吸区
const FALLBACK_BOTTOM = 12;
// V4.1.1 ④：原生导航栏高度钳上限（CSS px）。真实三键导航栏 ≤48dp，96 是防御性上限——
// 万一原生侧把物理 px 当 CSS px 注入（旧版 CI 补丁的单位 bug），也不至于把底部 Tab 顶飞。
const NAV_BAR_MAX = 96;

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

// V4.1.1 ④：读原生注入的导航栏高度。MainActivity 读 WindowInsets.navigationBars 后经
// evaluateJavascript 写到 documentElement 的 --navbar（见 .github/workflows/android.yml 的
// _pushNavBarToWebView）。只读内联样式：原生就是写在内联上的，不涉及其它来源。
// 返回 0 = 原生未注入（桌面 / 补丁跳过），行为与旧版一致。
function readNavBar(): number {
  try {
    const v = document.documentElement.style.getPropertyValue('--navbar').trim();
    if (!v) return 0;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

let lastNav = -1; // 上次 sync 时消费的 --navbar 值；MutationObserver 靠它去重，防自触发死循环

function sync(): void {
  const root = document.documentElement;
  const top = measure('env(safe-area-inset-top, 0px)');
  root.style.setProperty('--sat', `${top >= MIN_TOP ? top : FALLBACK_TOP}px`);
  const bottom = measure('env(safe-area-inset-bottom, 0px)');
  // V4.1.1 ④：--sab = max(env()实测, 12px 兜底, 原生导航栏高度)。
  // 三大金刚导航键机型 env() 恒 0，靠 --navbar 补真实高度（约 48dp）——此前只吃 12px 兜底，
  // Tab 栏/离线抽屉/启动页跳过钮被导航键盖住整整 36px。
  // 注意必须在 JS 侧合并：老 WebView 跳过 @supports(max()) 块，那条
  // `--sab: max(env(),12px,var(--navbar))` 根本不生效；且本函数的内联 --sab 本来就会
  // 盖掉样式表规则，光靠 CSS 改不动。
  const nav = readNavBar();
  lastNav = nav;
  const navClamped = nav > 0 && nav <= NAV_BAR_MAX ? nav : 0;
  root.style.setProperty('--sab', `${Math.max(bottom, FALLBACK_BOTTOM, navClamped)}px`);
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
  // V4.1.1 ④：监听原生注入的 --navbar。原生在 onStart 后 decor.post/300ms/1500ms 三连推，
  // 之后每次系统栏变化（旋转/导航栏显隐）都经 evaluateJavascript 重写内联样式——
  // MutationObserver 盯 documentElement 的 style 属性即可实时消费。
  // 去重靠 lastNav：sync 自身只写 --sat/--sab，不碰 --navbar，不会自触发。
  try {
    const mo = new MutationObserver(() => {
      if (readNavBar() === lastNav) return;
      sync();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  } catch {
    /* 老 WebView 无 MutationObserver：下面还有定时兜底 */
  }
  // 与原生推送时刻对齐的两次兜底（慢机型 WebView 注入可能晚于首次 sync）
  window.setTimeout(() => { try { sync(); } catch { /* ignore */ } }, 300);
  window.setTimeout(() => { try { sync(); } catch { /* ignore */ } }, 1500);
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
