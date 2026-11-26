// V4.5.3：TV 详情页网盘扫码授权弹窗（极简——二维码 + 打开 XX 网盘 App 扫码授权）。
// 机制同影视仓：弹窗内展示网盘官方登录页自带的扫码二维码；手机网盘 App 扫码确认后，
// 网页登录态建立 → 抓 cookie/refresh_token 落盘 → 关弹窗 → 自动重试当前集。
// 真机由 openNetdiskLogin 打开原生 NetdiskLoginActivity（官方登录页 + 强制桌面 UA + 自动抓 token）。
import { useEffect, useRef } from 'react';
import { type NetdiskKey, providerOf, getNetdiskToken } from '../../lib/netdisk';
import { openNetdiskLogin } from '../../lib/netdiskLogin';
import { focusElement } from '../../lib/focusNav';
import { pushBackHandler } from '../../lib/backStack';

export function NetdiskAuthTV({
  provider,
  onClose,
  onAuthed,
}: {
  provider: NetdiskKey;
  onClose: () => void;
  onAuthed: () => void;
}) {
  const p = providerOf(provider);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const closedRef = useRef(false);

  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  };

  // 授权成功 → 关弹窗 + 重试当前集
  useEffect(() => {
    const onChanged = () => {
      if (getNetdiskToken(provider)) {
        onAuthed();
        close();
      }
    };
    window.addEventListener('netdisk-tokens-changed', onChanged);
    // 若此刻已有 token（竞态：弹窗打开瞬间刚登录完），直接走成功
    if (getNetdiskToken(provider)) {
      onAuthed();
      close();
    }
    return () => window.removeEventListener('netdisk-tokens-changed', onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // 返回键关闭弹窗（不消费到详情页退出）
  useEffect(() => pushBackHandler(() => { close(); return true; }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // 焦点钉在「扫码授权」按钮，OK 即可打开登录页
  useEffect(() => {
    const t = [60, 200, 500].map((ms) => window.setTimeout(() => focusElement(btnRef.current), ms));
    return () => t.forEach(clearTimeout);
  }, []);

  const startLogin = () => { void openNetdiskLogin(p); };

  return (
    <div className="tv-overlay netdisk-auth-overlay" data-focus-root>
      <div className="netdisk-auth-card">
        <div className="nda-brand">
          <span className="nda-logo" style={{ background: p.color }}>{p.label.slice(0, 1)}</span>
          <span className="nda-name">{p.label}</span>
        </div>
        {/* 二维码：真机由官方登录页提供并可扫；此处图形仅作视觉引导，OK/点击即打开官方授权页 */}
        <div className="nda-qr">
          <canvas width={208} height={208} ref={(cv) => { if (cv) drawQr(cv); }} />
        </div>
        <div className="nda-tip">请使用 <b>{p.label} App</b> 扫码授权</div>
        <div className="nda-sub">打开 {p.label} App → 扫一扫 → 在手机上确认</div>
        <button
          ref={btnRef}
          className="nda-btn"
          data-focusable=""
          data-autofocus=""
          onClick={startLogin}
        >
          扫码授权（按 OK 打开）
        </button>
      </div>
    </div>
  );
}

// 示意二维码（三个定位角 + 伪随机块），视觉仿真；可扫的真二维码在官方登录页里
function drawQr(cv: HTMLCanvasElement) {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const N = 25, cell = 208 / N;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 208, 208); ctx.fillStyle = '#111';
  const finder = (ox: number, oy: number) => {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const e = x === 0 || x === 6 || y === 0 || y === 6;
      const c = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      if (e || c) ctx.fillRect((ox + x) * cell, (oy + y) * cell, cell, cell);
    }
  };
  finder(0, 0); finder(18, 0); finder(0, 18);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const inF = (x < 8 && y < 8) || (x >= 17 && y < 8) || (x < 8 && y >= 17);
    if (!inF && rnd() > 0.5) ctx.fillRect(x * cell, y * cell, cell, cell);
  }
}
