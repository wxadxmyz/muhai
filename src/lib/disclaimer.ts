// 搜索「使用须知」提示：成功添加/导入源后，在主页下方弹一次（2 秒自动消失）。
// 用 localStorage 记录是否已展示（清除数据/重装后重置），用 window 事件跨组件触发。
const KEY_SHOWN = 'disclaimer_shown';
const KEY_PENDING = 'disclaimer_pending';
const EVENT = 'disclaimer:request';

export function hasShownDisclaimer(): boolean {
  try {
    return localStorage.getItem(KEY_SHOWN) === '1';
  } catch {
    return false;
  }
}

export function markDisclaimerShown(): void {
  try {
    localStorage.setItem(KEY_SHOWN, '1');
  } catch {
    /* ignore */
  }
}

// 添加/导入源成功后调用：首次才需要弹；同时留 pending 标志，
// 若主页此时尚未挂载监听，挂载后也能补弹一次。
export function requestDisclaimerToast(): void {
  if (hasShownDisclaimer()) return;
  try {
    localStorage.setItem(KEY_PENDING, '1');
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* ignore */
  }
}

export function onDisclaimerRequest(cb: () => void): () => void {
  const handler = () => cb();
  try {
    window.addEventListener(EVENT, handler);
  } catch {
    /* ignore */
  }
  return () => {
    try {
      window.removeEventListener(EVENT, handler);
    } catch {
      /* ignore */
    }
  };
}

// 主页挂载时检查：若添加源时自己还没在监听事件，取走 pending 标志并补弹。
export function takePendingDisclaimer(): boolean {
  try {
    if (localStorage.getItem(KEY_PENDING) === '1') {
      localStorage.removeItem(KEY_PENDING);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
