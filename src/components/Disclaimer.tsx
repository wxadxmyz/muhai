import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../lib/settings';
import { isTV } from '../lib/deviceMode';
import { focusElement } from '../lib/focusNav';

// 首次启动免责声明。文案为自行撰写，不照搬任何第三方应用。
//
// V4.2.6 Q3：新增 TV 大卡片形态。旧版是 340px / 13px 字 / 18px 复选框的手机卡片，
// 投到电视上又小又难对准，且遥控器没有焦点框 —— 用户根本勾不动复选框、点不到「进入应用」。
// TV 形态改为：大卡片、大字号、一个大按钮「一键同意并进入」，挂载后自动聚焦该按钮，
// 遥控器按 OK/Enter 即可（focusNav 的 onKeyDown 会把 Enter/Space 转成 click）。
export function Disclaimer({ onAccept }: { onAccept: () => void }) {
  const { settings, update } = useSettings();
  const [checked, setChecked] = useState(false);
  const tvBtnRef = useRef<HTMLButtonElement | null>(null);
  const tv = isTV();

  // 电视上默认把焦点放到「一键同意」按钮，用户按一次遥控器确认键即可进入。
  useEffect(() => {
    if (!tv || settings.disclaimerAccepted) return;
    const t = window.setTimeout(() => focusElement(tvBtnRef.current), 60);
    return () => window.clearTimeout(t);
  }, [tv, settings.disclaimerAccepted]);

  if (settings.disclaimerAccepted) return null;

  const accept = () => {
    update({ disclaimerAccepted: true });
    onAccept();
  };

  const body = (
    <>
      <p>
        本软件是一款开源的<strong>本地媒体聚合播放工具</strong>，自身不提供、存储或分发任何影视、音乐等内容资源。
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

  if (tv) {
    return (
      <div className="disclaimer-mask disclaimer-tv" data-focus-root>
        <div className="disclaimer-card">
          <div className="disclaimer-tv-logo">幕海 MuHai</div>
          <h2>免责声明</h2>
          <div className="disclaimer-body">{body}</div>
          <p className="disclaimer-tv-hint">点击下方按钮即表示您已阅读、理解并同意上述声明。</p>
          <button
            ref={tvBtnRef}
            className="disclaimer-tv-btn"
            data-focusable=""
            onClick={accept}
          >
            一键同意并进入（按遥控器 OK 键）
          </button>
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
