import { useEffect, useState } from 'react';
import { useSkin, SKINS } from '../lib/theme';
import { useSettings } from '../lib/settings';
import { useSources } from '../store';
import { alistClient } from '../lib/alistClient';
import { isTauri, getAutostart, setAutostart, checkForUpdate, notify } from '../lib/tauriBridge';
import { downloadStore, setDownloadOptions } from '../lib/downloads';

export function SettingsModal({
  onClose,
  appName,
  store,
  libraryPayload,
}: {
  onClose: () => void;
  appName: string;
  store: ReturnType<typeof useSources>;
  libraryPayload?: () => string; // 返回待云同步的序列化数据
}) {
  const { skin, selectedId, setSkinId } = useSkin();
  const { settings, update } = useSettings();

  // P2-18 开机自启（仅 Tauri 桌面端有效）
  const [autostart, setAutostartState] = useState(false);
  const [autostartReady, setAutostartReady] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');

  useEffect(() => {
    if (!isTauri()) return;
    setAutostartReady(true);
    getAutostart().then(setAutostartState);
  }, []);

  const onAutostart = async (v: boolean) => {
    setAutostartState(v);
    await setAutostart(v);
    setAutostartState(await getAutostart());
  };

  const onCheckUpdate = async () => {
    if (!isTauri()) {
      setUpdateMsg('当前为网页原型，更新需在桌面端(Tauri 打包)内操作。');
      return;
    }
    setUpdating(true);
    setUpdateMsg('正在检查更新…');
    const r = await checkForUpdate();
    if (!r.available) setUpdateMsg('已是最新版本。');
    else if (r.updated) setUpdateMsg('已下载更新并重启。');
    else setUpdateMsg('发现新版本，但更新失败：' + (r.error || '未知错误') + '（请手动下载安装包）。');
    setUpdating(false);
  };

  const onToggleNotify = (v: boolean) => {
    update({ notifyDownload: v });
    setDownloadOptions({ notifyDownload: v });
  };

  const exportAll = () => {
    const data = { version: 1, sources: store.sources, settings };
    navigator.clipboard?.writeText(JSON.stringify(data, null, 2));
    alert('配置已复制到剪贴板（含音源与设置）。');
  };

  const importAll = () => {
    const text = window.prompt('粘贴此前导出的配置 JSON：');
    if (!text) return;
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data.sources)) for (const s of data.sources) store.importSources(JSON.stringify([s]));
      if (data.settings) update(data.settings);
      alert('导入完成，重启页面生效。');
    } catch (e: any) {
      alert('导入失败：' + (e?.message ?? ''));
    }
  };

  const cloudSync = async (mode: 'backup' | 'restore') => {
    const alistSrc = store.sources.find((s) => s.type === 'alist' && s.enabled);
    if (mode === 'backup') {
      const payload = libraryPayload ? libraryPayload() : JSON.stringify({ sources: store.sources, settings });
      const r = await alistClient.backup(alistSrc || null, payload);
      alert(r.message + (r.ok ? '可在另一台设备「从云盘恢复」。' : ''));
    } else {
      const r = await alistClient.restore(alistSrc || null);
      if (!r.data) return alert(r.message);
      try {
        const data = JSON.parse(r.data);
        if (Array.isArray(data.sources)) for (const s of data.sources) store.importSources(JSON.stringify([s]));
        if (data.settings) update(data.settings);
        alert(r.message + '（重启页面生效）。');
      } catch {
        alert('恢复失败：数据无法解析。');
      }
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-settings" onClick={(e) => e.stopPropagation()}>
        <h3>设置 · {appName}</h3>

        <label>主题外观（多套皮肤）</label>
        <div className="skin-grid">
          <button key="auto" className={'skin-cell auto ' + (selectedId === 'auto' ? 'active' : '')} onClick={() => setSkinId('auto')}>
            <span className="skin-swatch" style={{ background: 'linear-gradient(135deg,#1e2230 50%,#fdeef5 50%)' }} />
            <span className="skin-name">自动（跟随系统）</span>
          </button>
          {SKINS.map((s) => (
            <button key={s.id} className={'skin-cell ' + (selectedId === s.id ? 'active' : '')} onClick={() => setSkinId(s.id)}>
              <span className="skin-swatch" style={{ background: s.swatch }} />
              <span className="skin-name">{s.name}</span>
            </button>
          ))}
        </div>

        <label>默认音质</label>
        <select value={settings.defaultQuality} onChange={(e) => update({ defaultQuality: e.target.value as any })}>
          <option value="standard">标准</option>
          <option value="high">高品</option>
          <option value="lossless">无损</option>
        </select>

        <label>下载目录</label>
        <input value={settings.downloadDir} onChange={(e) => update({ downloadDir: e.target.value })} placeholder="如：D:/Media" />

        <div className="settings-cols">
          <label className="row">
            <input type="checkbox" checked={settings.autoNext} onChange={(e) => update({ autoNext: e.target.checked })} />
            自动连播下一首/集
          </label>
          <label className="row">
            <input type="checkbox" checked={settings.saveHistory} onChange={(e) => update({ saveHistory: e.target.checked })} />
            记录播放/观看历史
          </label>
          <label className="row">
            <input type="checkbox" checked={settings.enableDanmaku} onChange={(e) => update({ enableDanmaku: e.target.checked })} />
            显示弹幕
          </label>
          <label className="row">
            <input type="checkbox" checked={settings.enableSubtitle} onChange={(e) => update({ enableSubtitle: e.target.checked })} />
            显示字幕
          </label>
          <label className="row">
            <input type="checkbox" checked={settings.showDesktopLyric} onChange={(e) => update({ showDesktopLyric: e.target.checked })} />
            桌面歌词浮窗（音乐）
          </label>
        </div>

        <div className="inline-fields">
          <label>片头跳过(秒)<input type="number" min={0} value={settings.skipIntro} onChange={(e) => update({ skipIntro: Number(e.target.value) || 0 })} /></label>
          <label>片尾提前(秒)<input type="number" min={0} value={settings.skipOutro} onChange={(e) => update({ skipOutro: Number(e.target.value) || 0 })} /></label>
        </div>

        <label>数据云同步（借你的网盘，无需服务器）</label>
        {!store.sources.some((s) => s.type === 'alist' && s.enabled) && (
          <p className="muted sm hint-demo">云同步未启用：请先在「音源管理」添加一个 alist 源（baseUrl + Token）。未配置时不写入任何云盘，也不假装同步。</p>
        )}
        <div className="settings-actions">
          <button disabled={!store.sources.some((s) => s.type === 'alist' && s.enabled)} onClick={() => cloudSync('backup')}>备份到云盘</button>
          <button disabled={!store.sources.some((s) => s.type === 'alist' && s.enabled)} onClick={() => cloudSync('restore')}>从云盘恢复</button>
        </div>

        <label>桌面端系统能力（Tauri 打包后生效）</label>
        {!isTauri() && (
          <p className="muted sm hint-demo">以下能力需运行在桌面端(Tauri 打包)才可用；当前为网页原型，仅作说明。</p>
        )}
        <div className="settings-cols">
          <label className="row">
            <input type="checkbox" checked={autostart} disabled={!autostartReady} onChange={(e) => onAutostart(e.target.checked)} />
            开机自动启动
          </label>
          <label className="row">
            <input type="checkbox" checked={!!settings.notifyDownload} onChange={(e) => onToggleNotify(e.target.checked)} />
            下载完成系统通知
          </label>
        </div>
        <div className="settings-actions">
          <button disabled={updating || !isTauri()} onClick={onCheckUpdate}>检查更新</button>
          {updateMsg && <span className="muted sm">{updateMsg}</span>}
        </div>

        <label>配置导入/导出</label>
        <div className="settings-actions">
          <button onClick={exportAll}>导出配置</button>
          <button onClick={importAll}>导入配置</button>
        </div>

        <p className="muted sm about">
          窗口聚焦时快捷键已可用（空格 播放/暂停、左右方向键 进退、上下方向键 音量、M 静音、N/P 上下首）；桌面端(Tauri 打包)额外提供真·全局快捷键（窗口失焦仍可用媒体键控制）。
          系统托盘、开机自启、下载完成通知、自动更新 已在桌面端接入对应原生插件；真实投屏(DLNA/Chromecast)与安卓画中画为较重的原生能力，将在后续版本补齐。
        </p>

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}
