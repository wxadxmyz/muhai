// X1：横屏稳定性
// 问题：requestOrientation 原先直接写 (window as any).MuHaiAndroid?.setOrientation?.(ori)，
// 用的是可选链 —— 桥还没绑上时整行静默跳过、不报错也不重试，
// 表现就是"有时能真横屏、有时只 CSS 铺满没真转"。
// 方案：调用前先自检桥是否就绪；未就绪则轮询等待（每 100ms，最多 1.5s），就绪后立即调用。
// 这样即便用户手速快、在重试绑定窗口内点了横屏，也能等到桥绑上再转。

const BRIDGE_WAIT_MS = 1500;
const BRIDGE_POLL_MS = 100;

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

/**
 * 请求屏幕方向。桥未就绪时自动等待，就绪后立即生效。
 * @param ori 'landscape' | 'portrait' | 'sensor'
 */
export function requestOrientation(ori: 'landscape' | 'portrait' | 'sensor') {
  if (bridgeReady()) {
    callBridge(ori);
    return;
  }
  let waited = 0;
  const timer = window.setInterval(() => {
    waited += BRIDGE_POLL_MS;
    if (bridgeReady()) {
      callBridge(ori);
      window.clearInterval(timer);
    } else if (waited >= BRIDGE_WAIT_MS) {
      // 超时放弃，避免无限轮询
      window.clearInterval(timer);
    }
  }, BRIDGE_POLL_MS);
}
