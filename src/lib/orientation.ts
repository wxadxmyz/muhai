// X1：横屏稳定性
// 问题：requestOrientation 原先直接写 (window as any).MuHaiAndroid?.setOrientation?.(ori)，
// 用的是可选链 —— 桥还没绑上时整行静默跳过、不报错也不重试，
// 表现就是"有时能真横屏、有时只 CSS 铺满没真转"。
// 方案：调用前先自检桥是否就绪；未就绪则轮询等待（每 100ms，最多 3s），就绪后立即调用。

// 桥可能比首屏晚几秒才绑上（冷启动 / Tauri 重建 WebView 后），之前 3s 硬超时会导致
// "点一次只放大不转、再点一次才转"。放宽到 8s 且请求时会持续轮询直到真正转过去。
const BRIDGE_WAIT_MS = 8000;
const BRIDGE_POLL_MS = 100;
// Q2：发完指令不校验，系统没响应前端完全不知道 → 监听 orientationchange / resize 真正转过去再收尾，
//     并保留定时校验兜底（最多 ~2.4s）。
const VERIFY_DELAY_MS = 300;
const VERIFY_MAX_RETRY = 8; // X2：总校验窗口 ~2.4s，覆盖系统异步旋转耗时（原 3 次≈0.9s 偏短会"只放大不转"）

import { toast } from './toast';

function bridgeReady(): boolean {
  try {
    return typeof (window as any).MuHaiAndroid?.setOrientation === 'function';
  } catch {
    return false;
  }
}

function callBridge(ori: string) {
  try {
    (window as any).MuHaiAndroid?.setOrientation?.(ori);
  } catch {
    /* ignore */
  }
}

/** 实际是否已经转到目标朝向（横屏 = 宽大于高） */
function matches(ori: string): boolean {
  const isLand = window.innerWidth > window.innerHeight;
  if (ori === 'landscape') return isLand;
  if (ori === 'portrait') return !isLand;
  return true; // 'sensor' 交给系统，不校验
}

// 全局只绑一次旋转监听：orientationchange 发生时 innerWidth/innerHeight 随之更新，
// 下一次 verify 轮询即可读到 matches()===true 并提前收尾（比纯定时轮询更快确认到位）。
let verifyBound = false;
function ensureVerifyListeners() {
  if (verifyBound) return;
  verifyBound = true;
  const onChanged = () => { /* 仅触发 innerWidth 重算，verify 轮询会读到 */ };
  window.addEventListener('orientationchange', onChanged);
  window.addEventListener('resize', onChanged);
}

/**
 * Q2/Q3：发完指令后校验结果，没转过来就重试；重试耗尽仍失败 → toast 提示（桥可能没注入）。
 * CSS 铺满（.player-card.land / .live-video.fs）始终保证画面是横的，所以即便原生没响应也只是状态栏方向不变。
 */
function verifyAndRetry(ori: string, attempt: number) {
  if (ori === 'sensor') return; // sensor 不校验
  ensureVerifyListeners();
  window.setTimeout(() => {
    if (matches(ori)) return; // 已到位
    if (attempt < VERIFY_MAX_RETRY) {
      callBridge(ori);
      verifyAndRetry(ori, attempt + 1);
    } else {
      // 多次重试仍失败：CSS 铺满已保证画面横的，仅状态栏/导航栏方向不对 → 提示用户
      toast('横屏切换失败，请检查系统是否允许旋转');
    }
  }, VERIFY_DELAY_MS);
}

/**
 * 请求屏幕方向。桥未就绪时自动等待，就绪后立即调用，并在之后校验是否真的转过去了。
 * @param ori 'landscape' | 'portrait' | 'sensor'
 */
export function requestOrientation(
  ori: 'landscape' | 'portrait' | 'sensor',
  opts?: { silent?: boolean }
) {
  // portrait（退出横屏/页面清理）一律静默：CSS 铺满已兜底，且主页残留的"未就绪" toast 正是这类调用弹出的。
  const silent = opts?.silent || ori === 'portrait';
  const fire = () => { callBridge(ori); verifyAndRetry(ori, 1); };
  if (bridgeReady()) { fire(); return; }
  let waited = 0;
  const timer = window.setInterval(() => {
    waited += BRIDGE_POLL_MS;
    if (bridgeReady()) {
      window.clearInterval(timer);
      fire();
    } else if (waited >= BRIDGE_WAIT_MS) {
      window.clearInterval(timer);
      // 仅在用户主动要横屏（landscape）且桥确实没注入时才提示；清理类调用静默。
      if (!silent && ori === 'landscape') {
        toast('横屏桥未就绪，已用 CSS 铺满');
      }
    }
  }, BRIDGE_POLL_MS);
}

// ② 原生系统级画中画：点按钮即退出 App、桌面浮 16:9 小窗（A 方案）。
// 原生 MainActivity 注入 enterPip()（带 16:9 比例 + 权限检测 + 自定义关闭/全屏 action），
// 并在 onPictureInPictureModeChanged 里回调 window.__onPipChanged(true/false)。
export function pipBridgeReady(): boolean {
  try {
    return typeof (window as any).MuHaiAndroid?.enterPip === 'function';
  } catch {
    return false;
  }
}

export function enterPip() {
  try {
    if (pipBridgeReady()) (window as any).MuHaiAndroid.enterPip();
  } catch {
    /* 未注入原生桥时由调用方退化到 HTML5 PiP */
  }
}

/** 注册画中画状态回调；entered=true 进入小窗、false 退出小窗 */
export function setPipListener(cb: (entered: boolean) => void) {
  (window as any).__onPipChanged = cb;
}

// ③ 横屏沉浸模式：隐藏系统导航条/状态栏（粘性沉浸，从屏幕边缘往内滑一下临时出现、不点自动再藏）。
// 复用 MuHaiAndroid 桥的 immersive() 方法，就绪等待策略同 requestOrientation。
function immersiveBridgeReady(): boolean {
  try {
    return typeof (window as any).MuHaiAndroid?.immersive === 'function';
  } catch {
    return false;
  }
}

export function requestImmersive(on: boolean) {
  const call = () => {
    try { (window as any).MuHaiAndroid?.immersive?.(on); } catch { /* ignore */ }
  };
  if (immersiveBridgeReady()) { call(); return; }
  let waited = 0;
  const timer = window.setInterval(() => {
    waited += BRIDGE_POLL_MS;
    if (immersiveBridgeReady()) { call(); window.clearInterval(timer); }
    else if (waited >= BRIDGE_WAIT_MS) { window.clearInterval(timer); }
  }, BRIDGE_POLL_MS);
}
