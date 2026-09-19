// Q1：把 VideoPlayer 里的「缓冲转圈 + 快进加载圈」两套状态机抽成独立 hook，
// 与渲染/手势解耦，降低回归风险。逻辑原封不动搬出，行为保持不变。
import { useCallback, useRef, useState } from 'react';

export function useBuffering() {
  // ===== T 组：缓冲状态 =====
  const [buffering, setBuffering] = useState(false);
  const [bufPct, setBufPct] = useState(0);
  const bufferingTimer = useRef<number | undefined>(undefined);
  // T3：缓冲转圈延迟 300ms —— 快进后 200ms 内缓冲好就不显示，避免一闪而过反而像卡顿
  const markBuffering = useCallback(() => {
    if (bufferingTimer.current) window.clearTimeout(bufferingTimer.current);
    bufferingTimer.current = window.setTimeout(() => setBuffering(true), 300);
  }, []);
  const clearBuffering = useCallback(() => {
    if (bufferingTimer.current) { window.clearTimeout(bufferingTimer.current); bufferingTimer.current = undefined; }
    setBuffering(false);
  }, []);
  // ⑨：用户主动快进/拖动时的加载转圈（独立于 overlay，控件隐藏也显示；控件显示时滑动则隐藏其余控件）
  const [seekLoading, setSeekLoading] = useState(false);
  const [seekHideControls, setSeekHideControls] = useState(false);
  const seekLoadingTimer = useRef<number | undefined>(undefined);
  const seekGestureActive = useRef(false);
  const startSeekLoading = useCallback((hideControls: boolean) => {
    if (seekLoadingTimer.current) window.clearTimeout(seekLoadingTimer.current);
    seekLoadingTimer.current = undefined;
    seekGestureActive.current = true;
    setSeekHideControls(hideControls);
    setSeekLoading(true);
  }, []);
  const endSeekGesture = useCallback(() => {
    seekGestureActive.current = false;
    if (seekLoadingTimer.current) window.clearTimeout(seekLoadingTimer.current);
    // 抬手时若仍在缓冲（视频还没出新画面），交给 onSeeked→clearSeekLoadingOnSettled 清 seekLoading，
    // 此时常驻缓冲圈(buffering)已接力，避免"转一下就黑屏无圈"；仅未缓冲时才用 350ms 兜底清。
    if (buffering) return;
    seekLoadingTimer.current = window.setTimeout(() => { setSeekLoading(false); setSeekHideControls(false); }, 350);
  }, [buffering]);
  const clearSeekLoadingOnSettled = useCallback(() => {
    if (!seekGestureActive.current) {
      if (seekLoadingTimer.current) window.clearTimeout(seekLoadingTimer.current);
      setSeekLoading(false);
      setSeekHideControls(false);
    }
  }, []);

  return {
    buffering,
    bufPct,
    setBufPct,
    seekLoading,
    seekHideControls,
    markBuffering,
    clearBuffering,
    startSeekLoading,
    endSeekGesture,
    clearSeekLoadingOnSettled,
  };
}
