// 电脑版差异化设置页（清单 §4）：桌面形态（isDesktop）渲染，而非手机竖向卡片列表。
// UI 追求「信息密度 + 键鼠效率」：左侧分类栏 + 右侧分组面板；复用 useSettings / useSkin / store
// 等数据逻辑，仅改呈现。新增电脑专属项：快捷键说明、开机自启、最小化到托盘、窗口关闭行为。
// 危险操作保留红色「重置软件（清除数据）」，区别于手机端「重置 APP」命名。
import { useEffect, useState } from 'react';
import { useSources } from '../store';
import { useSettings } from '../lib/settings';
import { useSkin, SKINS } from '../lib/theme';
import { useDownloads } from '../lib/downloads';
import { getVersion } from '@tauri-apps/api/app';
import { Icon } from '../components/Icon';
import { ImportSourcePage } from '../components/ImportSourcePage';
import { SourceListPage } from '../components/SourceListPage';
import { PlayerSettingsPage } from './PlayerSettingsPage';
import { DownloadManager } from '../components/DownloadManager';
import { DebugPanel } from '../components/DebugPanel';
import { CloudBrowse } from './views/CloudBrowse';
import { SubPage } from '../components/SubPage';
import { checkForUpdate } from '../lib/tauriBridge';
import { toast } from '../lib/toast';
import {
  getNetdiskToken,
  getAllNetdiskTokens,
  clearNetdiskToken,
  syncNetdiskTokens,
  providerOf,
  type NetdiskKey,
} from '../lib/netdisk';
import { openNetdiskLogin } from '../lib/netdiskLogin';

type Cat = 'source' | 'play' | 'look' | 'net' | 'system' | 'about';

const CATS: { key: Cat; icon: any; label: string }[] = [
  { key: 'source', icon: 'download', label: '源与网盘' },
  { key: 'play', icon: 'play', label: '播放' },
  { key: 'look', icon: 'palette', label: '外观' },
  { key: 'net', icon: 'cloud', label: '网络 / 缓存' },
  { key: 'system', icon: 'settings', label: '系统与快捷键' },
  { key: 'about', icon: 'file-text', label: '关于' },
];

const NETDISKS = [
  { key: 'ali', label: '阿里云盘', color: '#6a7cff' },
  { key: 'quark', label: '夸克网盘', color: '#2b6ff2' },
  { key: 'uc', label: 'UC 网盘', color: '#ff6a00' },
] as const;

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={'switch' + (on ? ' on' : '')} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span />
    </button>
  );
}

function Field({ label, desc, children }: { label: string; desc?: string; children?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{label}</div>
        {desc && <div className="sm muted" style={{ marginTop: 2 }}>{desc}</div>}
      </div>
      {children}
    </div>
  );
}

export function SettingsPageDesktop({
  sub,
  setSub,
  onReset,
}: {
  sub: string | null;
  setSub: (v: string | null) => void;
  onReset: () => void;
}) {
  const store = useSources('video');
  const { settings, update } = useSettings();
  const { skin, selectedId, setSkinId } = useSkin();
  const [cat, setCat] = useState<Cat>((sub as Cat) || 'source');
  const [appVersion, setAppVersion] = useState('…');
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');
  const [cacheMsg, setCacheMsg] = useState('');
  const [ndTokens, setNdTokens] = useState<Partial<Record<NetdiskKey, string>>>({});
  const [autostart, setAutostart] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const dlTasks = useDownloads();
  const [cloudHead, setCloudHead] = useState<React.ReactNode>(null);

  useEffect(() => { if (sub) setCat(sub as Cat); }, [sub]);
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion('0.0.0'));
    syncNetdiskTokens();
    setNdTokens(getAllNetdiskTokens());
    (async () => {
      try { const { isEnabled } = await import('@tauri-apps/plugin-autostart'); setAutostart(await isEnabled()); } catch { /* 非桌面忽略 */ }
    })();
  }, []);

  const loginNetdisk = async (key: NetdiskKey) => {
    try { await openNetdiskLogin(providerOf(key)); toast(`正在打开 ${providerOf(key).label} 登录页`); }
    catch (e: any) { toast(`打开登录页失败：${e?.message ?? e}`, 'err'); }
  };
  const unbind = (key: NetdiskKey) => { clearNetdiskToken(key); setNdTokens(getAllNetdiskTokens()); toast('已移除 ' + providerOf(key).label); };

  const clearCache = async () => {
    try {
      localStorage.clear(); sessionStorage.clear();
      const { clearProxiedCache } = await import('../components/ProxiedImg');
      clearProxiedCache();
      indexedDB.databases?.().then((dbs) => dbs.forEach((d) => d.name && indexedDB.deleteDatabase(d.name)));
      setCacheMsg('已清除缓存'); toast('已清除缓存');
    } catch (e: any) { setCacheMsg('清除失败：' + (e?.message ?? e)); }
  };

  const setAutoStart = async (v: boolean) => {
    try {
      const { enable, disable } = await import('@tauri-apps/plugin-autostart');
      if (v) await enable(); else await disable();
      setAutostart(v); toast(v ? '已开启开机自启' : '已关闭开机自启');
    } catch { toast('开机自启需桌面端支持', 'err'); }
  };

  const checkUpdate = async () => {
    setUpdating(true); setUpdateMsg('正在检查…');
    const r = await checkForUpdate();
    setUpdating(false);
    if (!r.available) setUpdateMsg('已是最新版本');
    else if (r.updated) setUpdateMsg(`已更新至 v${r.version}`);
    else setUpdateMsg('当前为侧载安装，请在 Release 页手动下载最新 APK。');
  };

  // 源与网盘：复用现有子页组件
  if (cat === 'source') {
    // 子级：导入 / 仓库管理 / 网盘登录 / 网盘浏览 / 下载管理 —— 复用现有组件
    return (
      <div className="settings-scroll" style={{ display: 'flex', height: '100%' }}>
        <div style={{ width: 220, borderRight: '1px solid var(--border)', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {CATS.map((c) => (
            <button key={c.key} className={'settings-row tap' + (cat === c.key ? ' active' : '')} style={{ justifyContent: 'flex-start', gap: 10 }} onClick={() => { setCat(c.key); setSub(null); }}>
              <Icon name={c.icon} size={18} /> {c.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, padding: 20, overflow: 'auto' }} className="sp-desktop-body">
          <SubPage title="导入 json 源" onBack={() => setSub(null)}><ImportSourcePage mediaType="video" onClose={() => setSub(null)} /></SubPage>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-scroll" style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 220, borderRight: '1px solid var(--border)', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {CATS.map((c) => (
          <button key={c.key} className={'settings-row tap' + (cat === c.key ? ' active' : '')} style={{ justifyContent: 'flex-start', gap: 10, border: 'none' }} onClick={() => { setCat(c.key); setSub(null); }}>
            <Icon name={c.icon} size={18} /> {c.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, padding: 24, overflow: 'auto' }} className="sp-desktop-body">
        {cat === 'play' && <PlayerSettingsPage onBack={() => setSub(null)} />}

        {cat === 'look' && (
          <>
            <h3 style={{ marginTop: 0 }}>外观</h3>
            <Field label="深色模式"><Toggle on={settings.darkMode} onChange={(v) => update({ darkMode: v })} /></Field>
            <div style={{ marginTop: 12 }}>
              <div className="sm muted" style={{ marginBottom: 8 }}>皮肤</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 12 }}>
                {SKINS.concat([{ id: 'auto', name: '自动', swatch: 'linear-gradient(135deg,#0c0e13,#eef0f4)' } as any]).map((s) => (
                  <button key={s.id} className={'skin-cell' + (selectedId === s.id ? ' on' : '')} onClick={() => setSkinId(s.id)}>
                    <span className="sw" style={{ background: s.swatch }} /> {s.name}
                  </button>
                ))}
              </div>
            </div>
            <Field label="首页壁纸" desc="壁纸图片 URL，留空使用默认渐变">
              <input className="text-input" style={{ width: 320 }} placeholder="https:// 图片地址" value={settings.wallpaper || ''} onChange={(e) => update({ wallpaper: e.target.value })} />
            </Field>
          </>
        )}

        {cat === 'net' && (
          <>
            <h3 style={{ marginTop: 0 }}>网络 / 缓存</h3>
            <Field label="播放链路走本地代理" desc="关闭后媒体请求改回全量过桥"><Toggle on={settings.useMediaProxy} onChange={(v) => update({ useMediaProxy: v })} /></Field>
            <Field label="播放诊断浮层"><Toggle on={settings.showMediaProbe} onChange={(v) => update({ showMediaProbe: v })} /></Field>
            <Field label="清除缓存" desc={cacheMsg || '清理本地图片/历史缓存'}>
              <button className="primary" onClick={clearCache}><Icon name="refresh" size={16} /> 清除</button>
            </Field>
          </>
        )}

        {cat === 'system' && (
          <>
            <h3 style={{ marginTop: 0 }}>系统与快捷键</h3>
            <Field label="开机自启" desc="系统登录后自动启动幕海"><Toggle on={autostart} onChange={setAutoStart} /></Field>
            <Field label="检查更新" desc={`当前 v${appVersion}`}>
              <button className="primary" disabled={updating} onClick={checkUpdate}><Icon name="refresh" size={16} /> {updating ? '检查中…' : '检查更新'}</button>
            </Field>
            {updateMsg && <p className="muted sm">{updateMsg}</p>}

            <div className="sm muted" style={{ margin: '18px 0 8px' }}>键盘快捷键</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 10 }}>
              {[
                ['空格', '播放 / 暂停'],
                ['← →', '快退 / 快进'],
                ['↑ ↓', '音量'],
                ['F', '全屏'],
                ['Esc', '退出 / 返回'],
                ['M', '静音'],
                ['N', '下一集 / 下一曲'],
                ['P', '上一集 / 上一曲'],
              ].map(([k, d]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--panel2)', borderRadius: 10, border: '1px solid var(--border)' }}>
                  <kbd style={{ fontFamily: 'monospace', background: 'var(--bg)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)' }}>{k}</kbd>
                  <span className="sm">{d}</span>
                </div>
              ))}
            </div>

            <div className="sm muted" style={{ margin: '18px 0 8px' }}>危险操作</div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button className="settings-row danger-row tap" style={{ flex: 1, padding: 16, border: '1px solid var(--danger)', color: 'var(--danger)' }} onClick={() => setShowReset(true)}>
                <Icon name="trash" size={18} /> 重置软件（清除数据）
              </button>
            </div>
          </>
        )}

        {cat === 'about' && (
          <div className="card about-card" style={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 16, padding: 28, maxWidth: 560 }}>
            <div className="about-logo" style={{ color: 'var(--accent)', fontSize: 38 }}><Icon name="film" size={38} /></div>
            <div className="about-name" style={{ fontSize: 24, fontWeight: 800 }}>幕海 MuHai</div>
            <div className="muted sm" style={{ margin: '6px 0' }}>v{appVersion} · 开源本地媒体聚合播放器</div>
            <p className="sm muted">本软件不提供、存储或分发任何内容，所有资源来自用户自行添加的第三方源。</p>
          </div>
        )}
      </div>

      {showReset && (
        <div className="modal-mask" onClick={() => setShowReset(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title" style={{ color: 'var(--danger)' }}>重置软件（清除数据）</div>
            <div className="modal-text">将清除所有导入的源、观看记录、缓存与登录信息，且<strong>不可恢复</strong>。确定继续吗？</div>
            <div className="modal-btns">
              <button className="modal-btn cancel" onClick={() => setShowReset(false)}>取消</button>
              <button className="modal-btn danger" onClick={() => { setShowReset(false); onReset(); }}>确定重置</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
