// X1：横屏稳定性
// 问题：requestOrientation 原先直接写 (window as any).MuHaiAndroid?.setOrientation?.(ori)，
// 用的是可选链 —— 桥还没绑上时整行静默跳过、不报错也不重试，
// 表现就是"有时能真横屏、有时只 CSS 铺满没真转"。
// 方案：调用前先自检桥是否就绪；未就绪则轮询等待（每 100ms，最多 3s），就绪后立即调用。
// 这样即便用户手速快、在重试绑定窗口内点了横屏，也能等到桥绑上再转。

// Q1：1.5s 对慢机器 / WebView 冷启动偏短，桥还没绑上就超时放弃了 → 放宽到 3s
const BRIDGE_WAIT_MS = 3000;
const BRIDGE_POLL_MS = 100;
// Q2：发完指令不校验，系统没响应前端完全不知道 → 隔一会儿检查实际朝向，没到位就再发一次
const VERIFY_DELAY_MS = 300;
const VERIFY_MAX_RETRY = 3;

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

/**
 * Q2/Q3：发完指令后校验结果，没转过来就重试；重试耗尽仍失败则退回 CSS 铺满保底
 * （CSS 铺满由 .player-card.land / .live-video.fs 承担，所以即便原生没响应，画面也是横的）。
 */
function verifyAndRetry(ori: string, attempt: number) {
  if (ori === 'sensor') return; // sensor 不校验
  window.setTimeout(() => {
    if (matches(ori)) return;
    if (attempt < VERIFY_MAX_RETRY) {
      callBridge(ori);
      verifyAndRetry(ori, attempt + 1);
    }
    // Q3：3 次都失败 → 什么都不做，前端 CSS 铺满已经保证画面是横的，
    // 只是没有真的转屏（状态栏/导航栏方向不变）。这里不再无限重试，避免耗电。
  }, VERIFY_DELAY_MS);
}

/**
 * 请求屏幕方向。桥未就绪时自动等待，就绪后立即调用，并在之后校验是否真的转过去了。
 * @param ori 'landscape' | 'portrait' | 'sensor'
 */
export function requestOrientation(ori: 'landscape' | 'portrait' | 'sensor') {
  if (bridgeReady()) {
    callBridge(ori);
    verifyAndRetry(ori, 1);
    return;
  }
  let waited = 0;
  const timer = window.setInterval(() => {
    waited += BRIDGE_POLL_MS;
    if (bridgeReady()) {
      callBridge(ori);
      verifyAndRetry(ori, 1);
      window.clearInterval(timer);
    } else if (waited >= BRIDGE_WAIT_MS) {
      // 超时放弃，避免无限轮询（此时同样由 CSS 铺满保底）
      window.clearInterval(timer);
    }
  }, BRIDGE_POLL_MS);
}

// ② 原生系统级画中画：点按钮即退出 App、桌面浮 16:9 小窗（A 方案）。
// 原生 MainActivity 注入 enterPip()（带 16:9 比例 + 权限检测 + 自定义关闭/全屏 action），
// 并在 onPictureInPictureModeChanged 里回调 window.__onPipChanged(true/false)。
function pipBridgeReady(): boolean {
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
