import { useState } from 'react';
import { Icon } from './Icon';

// 投屏（演示占位）：真实 DLNA / Chromecast 设备发现需桌面端(Tauri 投屏插件)启用，
// 当前未接入，下方为可交互演示，点击不会真正投屏，仅用于展示交互。不承诺做不到的事。
const DEMO_DEVICES = [
  { id: 'demo1', name: '演示设备 A（DLNA·演示）', type: 'DLNA' },
  { id: 'demo2', name: '演示设备 B（Chromecast·演示）', type: 'Chromecast' },
];

export function CastOverlay({ onClose, onCast }: { onClose: () => void; onCast: (device: string) => void }) {
  const [scanning, setScanning] = useState(true);
  const [devices, setDevices] = useState<typeof DEMO_DEVICES>([]);

  useState(() => {
    setTimeout(() => {
      setScanning(false);
      setDevices(DEMO_DEVICES);
    }, 900);
  });

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>投屏（演示占位）</h3>
        <div className="warn-box">
          <Icon name="cast" size={16} /> 当前为<strong>演示占位</strong>：未接入真实 DLNA / Chromecast 设备发现。
          真实投屏将在桌面端(Tauri 投屏插件)上线后启用。下方为可交互演示，点击不会真正投屏。
        </div>
        {scanning ? (
          <div className="loading">正在搜索局域网设备…</div>
        ) : (
          <div className="cast-list">
            {devices.map((d) => (
              <button
                key={d.id}
                className="cast-device demo"
                onClick={() => {
                  onCast(d.name);
                  onClose();
                }}
              >
                <span className="cast-ico"><Icon name="cast" size={22} /></span>
                <span>{d.name}</span>
                <span className="badge demo">{d.type}·演示</span>
              </button>
            ))}
          </div>
        )}
        <p className="muted sm">提示：真实投屏需在桌面端打包后接入 DLNA/Chromecast 设备发现（见后续版本）。</p>
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
