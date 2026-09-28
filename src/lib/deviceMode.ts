// 设备形态判定（平板/电视适配的地基）。
//
// 为什么需要：之前「手机 / 横屏平板(=电脑版) / 电视」的判定散落在各处
//（orientation.ts 的 isAndroidEnv、tauriBridge 的 isTauri），没有统一出口。
// TV 界面层（HomeTV/SearchTV/...）、focusNav（遥控器焦点）、横屏放开（orientation）
// 都依赖"当前是什么设备形态"，统一在这里判定，避免各组件各写一套。
//
// 判定优先级（与《平板电视适配-更改清单.md》§1/§3.10 一致）：
//   1. 手动「电视模式」开关（localStorage 覆盖，最稳，绕过不可靠的 TV UA 探测）；
//   2. TV 启发式：无触摸 + 大屏 + (Android leanback UA 或 Android 无触摸大屏) → tv；
//   3. 宽度 + 触摸：
//      - 有触摸 且 宽 > 820 → desktop（横屏平板 = 电脑版，确认 UI）；
//      - 有触摸 且 宽 ≤ 820 → phone（手机 / 竖屏平板，走手机布局整体放大）；
//      - 无触摸 大屏(非 Android，如 Tauri 桌面端 / 桌面浏览器) → desktop（键鼠）。
//
// 注意：本模块只"判定形态"，不强制渲染任何 UI。VideoApp 是否切到 TV 组件、orientation
// 是否放开横屏，都由调用方读取这里的结果决定。这样本文件可以独立存在、不影响现有手机/桌面。

export type DeviceMode = 'phone' | 'desktop' | 'tv';

const TV_MODE_KEY = 'muhai_tv_mode';

function hasTouch(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(pointer: coarse)').matches) return true;
  } catch {
    /* matchMedia 不可用时退回 ontouchstart 探测 */
  }
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

function isAndroid(): boolean {
  try {
    return /Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

// Android TV / Google TV 的 UA 会带 Leanback / AndroidTV 字样；纯手机 UA 不带。
// 但不少盒子 UA 不暴露 TV 字样（风险清单 #2），故仅作"是电视"的加强信号，不作为唯一依据。
function isLeanbackUA(): boolean {
  try {
    return /(Leanback|AndroidTV|GoogleTV|googletv|android\.tv)/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

function viewportWidth(): number {
  return typeof window !== 'undefined' ? window.innerWidth : 1024;
}

/** 手动电视模式开关（用户可在设置里强制开启/关闭）。读不到时回退 false。 */
export function getManualTvMode(): boolean {
  try {
    return localStorage.getItem(TV_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setManualTvMode(on: boolean): void {
  try {
    localStorage.setItem(TV_MODE_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式 localStorage 不可用则忽略 */
  }
  recompute();
}

// 核心判定（纯函数，便于单测）。
export function detectDeviceMode(): DeviceMode {
  // 1) 手动开关最高优先
  if (getManualTvMode()) return 'tv';

  const touch = hasTouch();
  const w = viewportWidth();

  if (!touch) {
    // 无触摸大屏：可能是桌面(键鼠)或电视(遥控器)
    // 电视的强信号是 Android + (明确 leanback UA 或 大屏无触摸)；
    // 非 Android 的无触摸大屏（Tauri 桌面端 / 桌面浏览器原型）一律视为 desktop。
    if (isAndroid() && (isLeanbackUA() || w >= 1024)) return 'tv';
    return 'desktop';
  }

  // 有触摸：按宽度区分（确认 UI——竖屏平板=手机放大，横屏平板=电脑版）
  return w > 820 ? 'desktop' : 'phone';
}

// ── 缓存 + 变更通知 ──
// 形态在运行期会因旋转/缩放/手动开关变化，调用方（VideoApp）可订阅变更重渲染。
let cached: DeviceMode | null = null;
const listeners = new Set<(m: DeviceMode) => void>();

export function getDeviceMode(): DeviceMode {
  if (cached === null) cached = detectDeviceMode();
  return cached;
}

/** 订阅形态变更；返回取消订阅函数。 */
export function onDeviceModeChange(cb: (m: DeviceMode) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function recompute(): void {
  const next = detectDeviceMode();
  if (next !== cached) {
    cached = next;
    listeners.forEach((cb) => {
      try {
        cb(next);
      } catch {
        /* 单个订阅者异常不影响其他 */
      }
    });
  }
}

// 首屏后注册监听（窗口尺寸/旋转变化可能导致形态切换，如横屏平板转竖屏→phone）。
let installed = false;
export function installDeviceMode(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // 旋转/尺寸变化时重算；debounce 避免抖动
  let timer: number | undefined;
  const onResize = () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(recompute, 150);
  };
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });
}

// ── 便捷判定 ──
export const isTV = (): boolean => getDeviceMode() === 'tv';
export const isDesktop = (): boolean => getDeviceMode() === 'desktop';
export const isPhone = (): boolean => getDeviceMode() === 'phone';
/** 触屏设备（手机/平板）——焦点系统对触屏必须透明。 */
export const isTouchDevice = (): boolean => hasTouch();
