// V4.5.4：TV 详情页网盘扫码授权浮窗（影视仓式真二维码）。
// 机制：本组件是「等待/触发层」——挂载后自动拉起原生 NetdiskLoginActivity（Dialog 浮窗形态），
// 真二维码由网盘官方登录页 WebView 生成（带会话、可刷新），用户用手机网盘 App 扫真码并确认，
// 网页登录态建立 → 原生抓 cookie/refresh_token 落盘 → 派发 netdisk-tokens-changed →
// 本组件收到后 onAuthed() 自动重试当前集 + close() 关等待层。
import { useEffect, useRef } from 'react';
import { type NetdiskKey, providerOf, getNetdiskToken } from '../../lib/netdisk';
import { openNetdiskLogin } from '../../lib/netdiskLogin';
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
  const closedRef = useRef(false);
  const authedRef = useRef(false);

  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  };

  const authed = () => {
    if (authedRef.current) return;
    authedRef.current = true;
    onAuthed();
  };

  // 授权成功 → 关浮窗 + 重试当前集
  useEffect(() => {
    const onChanged = () => {
      if (getNetdiskToken(provider)) {
        authed();
        close();
      }
    };
    window.addEventListener('netdisk-tokens-changed', onChanged);
    // 竞态：拉起浮窗瞬间刚登录完
    if (getNetdiskToken(provider)) {
      authed();
      close();
    }
    return () => window.removeEventListener('netdisk-tokens-changed', onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // 返回键关闭等待层（不消费到详情页退出）
  useEffect(() => pushBackHandler(() => { close(); return true; }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // 进入即自动拉起原生真码浮窗（无需按 OK）。原生浮窗关闭后：
  //  - 已拿到 token：上面的事件回调已处理（authed + close）；
  //  - 用户取消：openNetdiskLogin 返回 null，这里兜底关闭等待层，避免卡住。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await openNetdiskLogin(p);
      } catch {
        /* 拉起失败也关闭等待层，避免卡死 */
      }
      if (cancelled) return;
      if (getNetdiskToken(provider)) {
        authed();
      }
      close();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="tv-overlay netdisk-auth-overlay" data-focus-root>
      <div className="netdisk-auth-card">
        <div className="nda-brand">
          <span className="nda-logo" style={{ background: p.color }}>{p.label.slice(0, 1)}</span>
          <span className="nda-name">{p.label}</span>
        </div>
        <div className="nda-qr nda-qr-wait">
          <span className="vp-spinner" />
        </div>
        <div className="nda-tip">正在打开 <b>{p.label}</b> 扫码授权…</div>
        <div className="nda-sub">请用手机 {p.label} App 扫描官方二维码并在手机上确认</div>
      </div>
    </div>
  );
}
