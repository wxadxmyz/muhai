import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Icon } from './Icon';
import { toast } from '../lib/toast';

interface DlnaDevice {
  name: string;
  location: string;
  controlUrl: string;
}

// 真实 DLNA / UPnP 投屏：调用 Rust 后端 dlnascan 扫描局域网设备，
// 选中后用 castvideo 把当前播放 URL 推送到设备的 AVTransport 服务。
// 设备需支持 DLNA 接收（智能电视、小米盒子、当贝等）。
// 后端不可用时（纯 Web 原型）优雅降级，提示需打包版本。
export function CastOverlay({ onClose, onCast, videoUrl }: { onClose: () => void; onCast: (device: string) => void; videoUrl?: string }) {
  const [scanning, setScanning] = useState(true);
  const [devices, setDevices] = useState<DlnaDevice[]>([]);
  const [error, setError] = useState('');

  const scan = useCallback(async (silent = false) => {
    if (!silent) { setScanning(true); setError(''); }
    try {
      const list = await invoke<DlnaDevice[]>('dlnascan', { timeoutMs: 4000 });
      setDevices(list);
      if (list.length === 0) {
        if (!silent) setError('未搜到局域网投屏设备，请确认电视/盒子已开机并连同一 Wi-Fi，且支持 DLNA 接收。');
      } else {
        setError(''); // 轮询发现设备后清掉旧提示
      }
    } catch (e: any) {
      if (!silent) setError(String(e?.message || e || '投屏设备发现失败（需在 Tauri 打包版内运行）'));
    } finally {
      if (!silent) setScanning(false);
    }
  }, []);

  // V3.5.7 F7：进场自动轮询（每 5s 静默重扫），UI 0 改动；组件卸载（关闭/取消）即清定时器
  useEffect(() => {
    scan();
    const t = window.setInterval(() => scan(true), 5000);
    return () => window.clearInterval(t);
  }, [scan]);

  const cast = async (d: DlnaDevice) => {
    if (!videoUrl) {
      toast('当前没有可投屏的播放地址');
      return;
    }
    try {
      const res = await invoke<string>('castvideo', { location: d.location, videoUrl });
      onCast(d.name);
      toast(res || `已投屏到 ${d.name}`);
      onClose();
    } catch (e: any) {
      toast('投屏失败：' + String(e?.message || e));
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="cast" size={18} style={{ color: 'var(--accent)' }} /> 投屏设备
        </h2>
        {scanning ? (
          <div className="loading">正在搜索局域网设备…</div>
        ) : error ? (
          <div className="warn-box"><Icon name="cast" size={16} /> {error}</div>
        ) : (
          <div className="cast-list">
            {devices.map((d, i) => (
              <button key={i} className="dev" onClick={() => cast(d)}>
                <Icon name="tv" size={20} className="ic" />
                <span className="nm">{d.name}</span>
                <span className="dlna">DLNA</span>
              </button>
            ))}
          </div>
        )}
        <p className="muted sm">提示：投屏依赖局域网 DLNA 设备（电视/盒子）。手机与设备需在同一 Wi-Fi。</p>
        <div className="modal-btns">
          <button className="modal-btn" onClick={() => scan()} disabled={scanning}><Icon name="refresh" size={16} /> 重新搜索</button>
          <button className="modal-btn primary" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
