import { useEffect } from 'react';

// 全局左右滑动手势返回：从屏幕左边缘右滑 60px+ 即触发逐级返回。
// 与 Android 物理返回键共用 window.__onAndroidBack()：返回 false 表示已逐级退一层（拦截），
// 返回 true 表示无内部层级（放行给系统退出）。仅监听左边缘，避免与页面内横向滚动冲突。
const EDGE = 40;        // 触发区：左边缘 40px 内
const MIN_DIST = 60;    // 最小滑动距离
const MAX_Y = 80;       // 纵向漂移上限（区分横滑/竖滑）

export function useSwipeBack() {
  useEffect(() => {
    let sx = 0, sy = 0, tracking = false, active = false;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      tracking = sx <= EDGE;
      active = false;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (Math.abs(dy) > MAX_Y && !active) { tracking = false; return; }
      if (dx > MIN_DIST) active = true;
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      tracking = false;
      if (dx >= MIN_DIST && Math.abs(dy) <= MAX_Y) {
        const fn = (window as any).__onAndroidBack;
        if (typeof fn === 'function') {
          try { fn(); } catch { /* ignore */ }
        }
      }
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, []);
}
