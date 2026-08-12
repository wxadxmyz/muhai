import { useState } from 'react';
import { useSettings } from '../lib/settings';

// 首次启动免责声明。文案为自行撰写，不照搬任何第三方应用。
export function Disclaimer({ onAccept }: { onAccept: () => void }) {
  const { settings, update } = useSettings();
  const [checked, setChecked] = useState(false);

  if (settings.disclaimerAccepted) return null;

  const accept = () => {
    update({ disclaimerAccepted: true });
    onAccept();
  };

  return (
    <div className="disclaimer-mask">
      <div className="disclaimer-card">
        <h2>免责声明</h2>
        <div className="disclaimer-body">
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
