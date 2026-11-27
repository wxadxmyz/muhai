import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../lib/settings';
import { isTV } from '../lib/deviceMode';
import { focusElement, isTvConfirmKey } from '../lib/focusNav';
import { exitApp } from '../lib/tauriBridge';

// 首次启动免责声明。文案为自行撰写，不照搬任何第三方应用。
//
// V4.2.6 Q3：新增 TV 大卡片形态。旧版是 340px / 13px 字 / 18px 复选框的手机卡片，
// 投到电视上又小又难对准，且遥控器没有焦点框 —— 用户根本勾不动复选框、点不到「进入应用」。
// TV 形态改为：大卡片、大字号、一个大按钮「一键同意并进入」，挂载后自动聚焦该按钮，
// 遥控器按 OK/Enter 即可（focusNav 的 onKeyDown 会把 Enter/Space 转成 click）。
export function Disclaimer({ onAccept }: { onAccept: () => void }) {
  const { settings, update } = useSettings();
  const [checked, setChecked] = useState(false);
  const exitRef = useRef<HTMLButtonElement | null>(null);
  const agreeRef = useRef<HTMLButtonElement | null>(null);
  const tv = isTV();
  // V4.4.6：电视端免责说明 5 秒自动倒计时，归零自动同意并进入——
  // 用户不必再「先按下键、再按确定」。倒计时仅为提示，任意键/点击仍可立即进入。
  const [countdown, setCountdown] = useState(5);
  const acceptedRef = useRef(false);

  // 电视上默认把焦点放到「一键同意」按钮，用户按一次遥控器确认键即可进入。
  // V4.4.4：老 WebView 首次渲染后焦点尚未就位，60ms 一次可能太早/被系统回收，
  // 这里多点重试（60/200/500ms）把焦点「钉」在按钮上，配合 focusNav 的 OK 兜底双保险。
  useEffect(() => {
    if (!tv || settings.disclaimerAccepted) return;
    // V4.5.3 #16：增加 800/1200ms 重试，覆盖更慢的电视首帧（部分机型 500ms 仍未就位）。
    const timers = [60, 200, 500, 800, 1200].map((ms) =>
      window.setTimeout(() => focusElement(agreeRef.current), ms)
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [tv, settings.disclaimerAccepted]);

  // V4.4.6：电视端 5 秒自动倒计时，归零自动同意并进入（无需先按下键再按确定）。
  // 只改本地倒计时显示，真正进入仍走 accept()（update + onAccept），保证与手动点击完全同一条路径。
  useEffect(() => {
    if (!tv || settings.disclaimerAccepted) return;
    const start = Date.now();
    const tick = window.setInterval(() => {
      const left = Math.max(0, 5 - Math.floor((Date.now() - start) / 1000));
      setCountdown(left);
      // V4.5.3 #16：倒计时每次 tick 重渲染可能把焦点冲掉（用户看到光标不在「同意」上）——
      // 每次 tick 补一次焦点，把可移动光标钉在默认「同意」按钮；用户已手动移到「退出」时不打扰。
      const ae = document.activeElement as HTMLElement | null;
      if (!ae || !ae.hasAttribute || !ae.hasAttribute('data-disclaimer-btn')) {
        focusElement(agreeRef.current);
      }
      if (left <= 0) {
        window.clearInterval(tick);
        accept();
      }
    }, 200);
    return () => window.clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tv, settings.disclaimerAccepted]);

  // V4.5.1 #1：免责改为「退出 / 同意」双按钮后，不再「任意键即进入」。
  // 方向键交给 focusNav 在两个按钮间移动焦点；OK/Enter 只触发当前聚焦的按钮。
  // 仅需一个 window 捕获阶段兜底：部分老 WebView 首次 OK 时 activeElement 还停在 body，
  // focusNav 的 activeElement 判定失效——此时把焦点补到默认「同意」按钮并点击。
  // 用 isTvConfirmKey 统一识别 OK（含 keyCode 13/23/66，覆盖盒子误报），返回键不在此列。
  useEffect(() => {
    if (settings.disclaimerAccepted) return;
    const onKey = (e: KeyboardEvent) => {
      const isBack = e.key === 'Backspace' || e.key === 'Escape' || e.key === 'GoBack' ||
        e.key === 'BrowserBack' || e.key === 'Back' || e.key === 'Go back' ||
        (e as any).keyCode === 4 || (e as any).keyCode === 27;
      if (isBack) return; // 返回键不处理，交给系统/其他层
      if (!isTvConfirmKey(e as any)) return; // 方向键等交给 focusNav 移动焦点
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae.hasAttribute && ae.hasAttribute('data-disclaimer-btn')) {
        // 焦点已在某个按钮上：交给 focusNav 正常 click，这里不重复处理
        return;
      }
      // 焦点未就位：补到默认「同意」按钮并点击
      e.preventDefault();
      e.stopPropagation();
      const target = agreeRef.current || exitRef.current;
      if (target) { focusElement(target); target.click(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.disclaimerAccepted]);

  if (settings.disclaimerAccepted) return null;

  const accept = () => {
    if (acceptedRef.current) return; // V4.4.6：倒计时归零与手动点击可能并发，幂等只进一次
    acceptedRef.current = true;
    update({ disclaimerAccepted: true });
    onAccept();
  };

  const body = (
    <>
      <p>
        本软件是一款开源的<strong>本地影视聚合播放工具</strong>，自身不提供、存储或分发任何影视内容资源。
      </p>
      <p>
        软件内所有可播放内容，均来自<strong>用户自行添加</strong>的第三方接口配置地址（源）。
        这些资源由相应提供方负责，其合法性、稳定性与安全性与本软件及开发者无关。
      </p>
      <p>
        请您在遵守所在地区法律法规的前提下使用本软件，仅用于播放您拥有合法授权的个人内容。
        如因添加或使用第三方源产生任何纠纷或后果，均由使用者自行承担。
      </p>
    </>
  );

  // V4.5.1 #1：双按钮后去掉 data-ok-once-root——focusNav 的「首次 OK 强制点 autofocus」兜底
  // 会在焦点已落在「退出」上时误点「同意」。OK 统一由本组件 window 捕获监听 + focusNav 正常 click 处理。
  if (tv) {
    return (
      <div className="disclaimer-mask disclaimer-tv" data-focus-root>
        <div className="disclaimer-card">
          <div className="disclaimer-tv-logo">幕海 MuHai</div>
          <h2>免责声明</h2>
          <div className="disclaimer-body">{body}</div>
          <p className="disclaimer-tv-hint">{countdown > 0 ? `${countdown} 秒后自动同意并进入，或按「同意」立即进入。` : '正在进入…'}</p>
          <div className="disclaimer-tv-actions">
            <button
              ref={exitRef}
              className="disclaimer-tv-btn exit"
              data-focusable=""
              data-disclaimer-btn=""
              onClick={exitApp}
            >
              退出
            </button>
            <button
              ref={agreeRef}
              className="disclaimer-tv-btn agree"
              data-focusable=""
              data-autofocus=""
              data-disclaimer-btn=""
              onClick={accept}
            >
              同意并进入（{countdown > 0 ? `${countdown}s` : '进入中'}）
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="disclaimer-mask">
      <div className="disclaimer-card">
        <h2>免责声明</h2>
        <div className="disclaimer-body">
          {body}
          <p className="muted sm">继续即表示您已阅读、理解并同意上述声明。</p>
        </div>
        <label className="disclaimer-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          我已阅读并同意《免责声明》
        </label>
        <button className="primary block" disabled={!checked} onClick={accept}>
          进入应用
        </button>
      </div>
    </div>
  );
}
