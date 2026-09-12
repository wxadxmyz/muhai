// X1：横屏稳定性
// 问题：requestOrientation 原先直接写 (window as any).MuHaiAndroid?.setOrientation?.(ori)，
// 用的是可选链 —— 桥还没绑上时整行静默跳过、不报错也不重试，
// 表现就是"有时能真横屏、有时只 CSS 铺满没真转"。
// 方案：调用前先自检桥是否就绪；未就绪则轮询等待（每 100ms，最多 3s），就绪后立即调用。

// 桥可能比首屏晚几秒才绑上（冷启动 / Tauri 重建 WebView 后）。原生侧在 onStart/onResume/
// onWindowFocusChanged 里 postDelayed 重试绑桥（V3.3.0 #7 加长到 10s），前端这边同步放宽等待：
const BRIDGE_WAIT_MS = 20000; // V3.3.0 #7：8s → 12s → 20s，慢机型 / 重开后 WebView 挂载更晚，给自愈绑桥留足时间
const BRIDGE_POLL_MS = 100;
// V3.3.0 #7：等桥 3s 仍未就绪先给一条"连接中"提示——别让用户点了横屏毫无反馈干等
const WAIT_HINT_AT_MS = 3000;
// Q2：发完指令不校验，系统没响应前端完全不知道 → 监听 orientationchange / resize 真正转过去再收尾，
//     并保留定时校验兜底。V3.3.0 #7：校验窗口 2.4s → 6s（慢机型系统异步旋转更久），
//     期间每 400ms 重发一次指令，直到 matches() 为 true。
const VERIFY_DELAY_MS = 400;
const VERIFY_MAX_RETRY = 15; // V3.3.0 #7：总校验窗口 ~6s

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

// 是否 Android 环境：只有 Android 才需要（也才能）走原生方向指令。
// 桌面端/浏览器直接放行——否则点横屏会去等一个永远不存在的桥，白等 12 秒。
function isAndroidEnv(): boolean {
  try {
    return /Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/**
 * V3.3.7 十一：校验重试链代际 token——requestOrientation 每次新调用作废旧链。
 * 场景：横屏校验链还在重试时用户退出播放页（发 portrait），旧链不知情，
 * 之后每 400ms 继续重发 landscape 指令，把屏幕又翻回横屏（残留重试翻屏 bug）。
 */
let verifyGen = 0;

/**
 * Q2/Q3：发完指令后校验结果，没转过来就重试；重试耗尽仍失败 → 通过 onResult(false) 通知调用方。
 * onResult 是 V3.3.7 十一 新增：让「点横屏键」这一侧能知道到底转没转成功，
 * 从而做到「没转成功就不切横屏 UI」，彻底消灭「竖屏放大」的假横屏状态。
 */
function verifyAndRetry(ori: string, attempt: number, gen: number, onResult?: (ok: boolean) => void) {
  if (ori === 'sensor') { onResult?.(true); return; } // sensor 不校验（交给系统）
  ensureVerifyListeners();
  window.setTimeout(() => {
    if (gen !== verifyGen) return; // 已有更新的方向请求，本链作废，不再重发指令
    if (matches(ori)) { onResult?.(true); return; } // 已到位
    if (attempt < VERIFY_MAX_RETRY) {
      callBridge(ori);
      verifyAndRetry(ori, attempt + 1, gen, onResult);
    } else {
      // 多次重试仍失败：桥活着但系统没转 → 提示用户检查系统设置（调用方只做回退，不再重复提示）
      toast('横屏切换失败，请检查系统是否允许旋转');
      onResult?.(false); // 重试耗尽：明确告知失败，由调用方决定回退策略
    }
  }, VERIFY_DELAY_MS);
}

// V3.3.0 #7：同一时刻只保留一个"等桥轮询"——新请求取消旧请求。
// 场景：进播放页先发 'sensor'（静默等桥），3 秒后用户点横屏按钮发 'landscape'，
// 若不取消，sensor 的旧轮询在桥就绪后会把方向又改回 sensor，覆盖横屏指令。
let pendingWait: number | null = null;

/**
 * 请求屏幕方向。桥未就绪时自动等待，就绪后立即调用，并在之后校验是否真的转过去了。
 * @param ori 'landscape' | 'portrait' | 'sensor'
 */
export function requestOrientation(
  ori: 'landscape' | 'portrait' | 'sensor',
  opts?: { silent?: boolean; onResult?: (ok: boolean) => void }
) {
  // portrait/sensor（进入页面/清理类调用）一律静默；landscape 是用户主动要的，失败要提示。
  const silent = opts?.silent || ori === 'portrait' || ori === 'sensor';
  const onResult = opts?.onResult;
  // V3.3.7 十一：非 Android（桌面端/浏览器）没有原生方向这回事，直接放行，
  // 由调用方切 CSS 全屏即可，绝不能去等一个永远不会出现的桥。
  if (!isAndroidEnv()) { onResult?.(true); return; }
  const myGen = ++verifyGen; // V3.3.4：作废之前所有校验链（防止残留链把方向翻回去）
  const fire = () => { callBridge(ori); verifyAndRetry(ori, 1, myGen, onResult); };
  if (pendingWait !== null) {
    window.clearInterval(pendingWait);
    pendingWait = null;
  }
  if (bridgeReady()) { fire(); return; }
  let waited = 0;
  let hinted = false;
  const timer = window.setInterval(() => {
    waited += BRIDGE_POLL_MS;
    if (bridgeReady()) {
      if (pendingWait !== null) { window.clearInterval(pendingWait); pendingWait = null; }
      fire();
    } else if (waited >= BRIDGE_WAIT_MS) {
      if (pendingWait !== null) { window.clearInterval(pendingWait); pendingWait = null; }
      onResult?.(false); // V3.3.7 十一：桥始终没来 → 明确失败，调用方不切横屏 UI
      // 仅在用户主动要横屏（landscape）且桥确实没注入时才提示；清理类调用静默。
      if (!silent && ori === 'landscape') {
        toast('旋转服务未就绪，请退出播放页重新进入后再点横屏'); // V3.3.0 #7：给出可操作的恢复路径
      }
    } else if (!silent && ori === 'landscape' && !hinted && waited >= WAIT_HINT_AT_MS) {
      hinted = true;
      toast('旋转服务连接中…');
    }
  }, BRIDGE_POLL_MS);
  pendingWait = timer;
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