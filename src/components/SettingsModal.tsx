import { useEffect, useState, type ReactNode } from 'react';
import { useSkin, SKINS } from '../lib/theme';
import { useSettings } from '../lib/settings';
import { useSources } from '../store';
import { alistClient } from '../lib/alistClient';
import { isTauri, getAutostart, setAutostart, checkForUpdate } from '../lib/tauriBridge';
import { downloadStore, setDownloadOptions } from '../lib/downloads';
import { Icon, type IconName } from './Icon';

/* ---------- 分组卡片原子组件 ---------- */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="settings-group-title">{title}</div>
      <div className="settings-card">{children}</div>
    </div>
  );
}

function Row({
  icon,
  label,
  sub,
  value,
  onClick,
  children,
}: {
  icon?: IconName;
  label: string;
  sub?: string;
  value?: string;
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className={'settings-row' + (onClick ? ' tap' : '')} onClick={onClick}>
      {icon && (
        <span className="ico">
          <Icon name={icon} size={18} />
        </span>
      )}
      <span className="label">
        {label}
        {sub && <small>{sub}</small>}
      </span>
      {value && <span className="value">{value}</span>}
      {children}
      {onClick && !children && (
        <span className="chevron">
          <Icon name="arrow-right" size={16} />
        </span>
      )}
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <span
      className={'switch' + (checked ? ' on' : '')}
      role="switch"
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    />
  );
}

export function SettingsModal({
  onClose,
  appName,
  store,
  libraryPayload,
  favoritesCount = 0,
  playlistsCount = 0,
  onOpenSources,
  onOpenCloud,
  onOpenMyMusic,
}: {
  onClose: () => void;
  appName: string;
  store: ReturnType<typeof useSources>;
  libraryPayload?: () => string;
  favoritesCount?: number;
  playlistsCount?: number;
  onOpenSources?: () => void;
  onOpenCloud?: () => void;
  onOpenMyMusic?: (tab: 'favorites' | 'playlists') => void;
}) {
  const { skin, selectedId, setSkinId } = useSkin();
  const { settings, update } = useSettings();
  const isMusic = appName === '音乐';

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

  const importSource = () => {
    const text = window.prompt('粘贴音源 JSON（单个对象或数组）：');
    if (!text) return;
    try {
      const r = store.importSources(text);
      alert(r.added > 0 ? `已导入 ${r.added} 个音源。` : '未导入：' + (r.errors[0] || '格式不正确'));
    } catch (e: any) {
      alert('导入失败：' + (e?.message ?? ''));
    }
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

  const hasAlist = store.sources.some((s) => s.type === 'alist' && s.enabled);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-settings" onClick={(e) => e.stopPropagation()}>
        <h3>设置 · {appName}</h3>

        <div className="settings-scroll">
          {isMusic && (
            <Group title="我的音乐">
              <Row icon="heart" label="我的喜欢" value={`${favoritesCount} 首`} onClick={() => onOpenMyMusic?.('favorites')} />
              <Row icon="list" label="创建的歌单" value={`${playlistsCount} 个`} onClick={() => onOpenMyMusic?.('playlists')} />
            </Group>
          )}

          <Group title={isMusic ? '音源' : '源管理'}>
            <Row icon="plug" label="音源管理" sub={isMusic ? '导入 / 切换 / 编辑 JSON 音源' : '影视源 · 直播源 · 网盘源'} onClick={onOpenSources} />
            <Row icon="file-text" label="导入音源(JSON)" onClick={importSource} />
          </Group>

          {!isMusic && (
            <Group title="网盘">
              <Row icon="folder" label="浏览网盘" sub="登录阿里/夸克/WebDAV 后查看媒体" onClick={onOpenCloud} />
              {!hasAlist && <div className="settings-note">未检测到 alist 网盘源。先在「音源管理」添加一个 alist 源（baseUrl + Token）即可浏览。</div>}
            </Group>
          )}

          <Group title="下载">
            {isMusic && (
              <Row icon="download" label="默认音质">
                <select value={settings.defaultQuality} onChange={(e) => update({ defaultQuality: e.target.value as any })}>
                  <option value="standard">标准</option>
                  <option value="high">高品</option>
                  <option value="lossless">无损</option>
                </select>
              </Row>
            )}
            <Row icon="folder" label="下载目录">
              <input type="text" value={settings.downloadDir} onChange={(e) => update({ downloadDir: e.target.value })} placeholder="如：D:/Media" />
            </Row>
            <Row label="下载完成通知">
              <Switch checked={!!settings.notifyDownload} onChange={onToggleNotify} />
            </Row>
          </Group>

          <Group title="播放">
            {isMusic && (
              <Row icon="sliders" label="桌面歌词浮窗">
                <Switch checked={!!settings.showDesktopLyric} onChange={(v) => update({ showDesktopLyric: v })} />
              </Row>
            )}
            <Row icon="repeat" label="自动连播">
              <Switch checked={!!settings.autoNext} onChange={(v) => update({ autoNext: v })} />
            </Row>
            {!isMusic && (
              <>
                <Row icon="play" label="跳过片头(秒)">
                  <input type="number" min={0} value={settings.skipIntro} onChange={(e) => update({ skipIntro: Number(e.target.value) || 0 })} />
                </Row>
                <Row icon="fast-forward" label="跳过片尾(秒)">
                  <input type="number" min={0} value={settings.skipOutro} onChange={(e) => update({ skipOutro: Number(e.target.value) || 0 })} />
                </Row>
                <Row icon="cast" label="显示弹幕">
                  <Switch checked={!!settings.enableDanmaku} onChange={(v) => update({ enableDanmaku: v })} />
                </Row>
                <Row icon="captions" label="显示字幕">
                  <Switch checked={!!settings.enableSubtitle} onChange={(v) => update({ enableSubtitle: v })} />
                </Row>
              </>
            )}
          </Group>

          {!isMusic && (
            <Group title="直播">
              <div className="settings-note">直播线路来自音源 JSON 中含直播(m3u8/直播源)的条目。在「音源管理」导入含直播线路的源后，「直播」页即可观看。</div>
            </Group>
          )}

          <Group title="外观">
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
          </Group>

          <Group title="通用">
            <Row icon="list" label="记录播放/观看历史">
              <Switch checked={!!settings.saveHistory} onChange={(v) => update({ saveHistory: v })} />
            </Row>
            <Row icon="download" label="检查更新" value={updating ? '检查中…' : ''} onClick={onCheckUpdate} />
            {updateMsg && <div className="settings-note">{updateMsg}</div>}
            <div className="settings-actions">
              <button onClick={exportAll}>导出配置</button>
              <button onClick={importAll}>导入配置</button>
            </div>
            <div className="settings-actions">
              <button disabled={!hasAlist} onClick={() => cloudSync('backup')}>备份到云盘</button>
              <button disabled={!hasAlist} onClick={() => cloudSync('restore')}>从云盘恢复</button>
            </div>
            {!hasAlist && <div className="settings-note">云同步需先添加 alist 网盘源（或在「音源管理」配置）。未配置时不写入任何云盘。</div>}
            {!isTauri() && <div className="settings-note">开机自启、系统通知、自动更新 需在桌面端(Tauri 打包)内生效；当前为网页原型。</div>}
          </Group>

          <p className="muted sm about">
            窗口聚焦时快捷键已可用（空格 播放/暂停、左右方向键 进退、上下方向键 音量、M 静音、N/P 上下首）；桌面端(Tauri 打包)额外提供真·全局快捷键。
          </p>
        </div>

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
