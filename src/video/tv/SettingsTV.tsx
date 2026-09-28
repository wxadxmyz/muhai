// TV 设置页（清单 §3.5）：2~3 列网格大按钮（图标 + 标题 + 当前值 + 右箭头），
// 点击进入子设置弹层；子页保持 TV 大按钮列表。遥控器方向键在网格中移动焦点。
import { useEffect, useState } from 'react';
import { useSettings } from '../../lib/settings';
import { getVersion } from '@tauri-apps/api/app';
import { getManualTvMode, setManualTvMode } from '../../lib/deviceMode';
import { useSkin, SKINS } from '../../lib/theme';
import { Icon } from '../../components/Icon';
import { pushBackHandler } from '../../lib/backStack';
import { clearProxiedCache, proxiedCacheBytes } from '../../components/ProxiedImg';
import { toast } from '../../lib/toast';
import { RemotePushTV } from './RemotePushTV';

function TVSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      className={'switch' + (on ? ' on' : '')}
      data-focusable=""
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      style={{ width: 64, height: 36, borderRadius: 999, background: on ? 'var(--accent)' : 'var(--panel2)', position: 'relative', cursor: 'pointer', flex: '0 0 auto' }}
    >
      <span style={{ position: 'absolute', top: 4, left: on ? 32 : 4, width: 28, height: 28, borderRadius: '50%', background: '#fff', transition: '.15s' }} />
    </div>
  );
}

function Row({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 18 }}>{label}</span>
      {children}
    </div>
  );
}

function Seg({ value, options, onChange }: { value: string; options: { v: string; l: string }[]; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {options.map((o) => (
        <span
          key={o.v}
          className={'tv-line-pill' + (value === o.v ? ' active' : '')}
          data-focusable=""
          onClick={() => onChange(o.v)}
          role="button"
        >
          {o.l}
        </span>
      ))}
    </div>
  );
}

export function SettingsTV({ onReset }: { onReset: () => void }) {
  const { settings, update } = useSettings();
  const { skin, selectedId, setSkinId } = useSkin();
  const [panel, setPanel] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState('…');
  const [tvMode, setTvMode] = useState(getManualTvMode());
  const [cacheMsg, setCacheMsg] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  useEffect(() => { getVersion().then(setAppVersion).catch(() => setAppVersion('0.0.0')); }, []);

  const open = (p: string) => setPanel(p);
  useEffect(() => {
    if (!panel) return;
    return pushBackHandler(() => { setPanel(null); return true; });
  }, [panel]);

  const cacheBytes = proxiedCacheBytes();
  const fmtCache = (b: number) => (b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + 'M' : Math.round(b / 1024) + 'K');

  const cards = [
    { key: 'play', icon: 'play', t: '播放', v: settings.hardwareDecode ? '硬解' : '软解' },
    { key: 'look', icon: 'palette', t: '外观', v: skin.name },
    { key: 'net', icon: 'cloud', t: '网络/缓存', v: fmtCache(cacheBytes) },
    { key: 'source', icon: 'download', t: '添加源', v: '扫码' },
    { key: 'tv', icon: 'tv', t: '电视模式', v: tvMode ? '已开' : '自动' },
    { key: 'about', icon: 'file-text', t: '关于', v: 'v' + appVersion },
  ];

  return (
    <div className="tv-scroll" data-scroll>
      <div className="tv-set-grid">
        {cards.map((c) => (
          <div key={c.key} className="tv-set-card" data-focusable="" onClick={() => open(c.key)} role="button">
            <span className="ic"><Icon name={c.icon as any} size={26} /></span>
            <span className="t">{c.t}</span>
            <span className="v">{c.v}</span>
          </div>
        ))}
        <div className="tv-set-card danger" data-focusable="" onClick={() => setShowResetConfirm(true)} role="button">
          <span className="ic"><Icon name="trash" size={26} /></span>
          <span className="t">重置软件（清除数据）</span>
          <span className="v">清空所有数据</span>
        </div>
      </div>

      {panel && panel !== 'source' && panel !== 'tv' && (
        <div className="tv-overlay" data-focus-root>
          <div className="tv-sheet">
            <div className="tv-sheet-head">
              <h3>{cards.find((c) => c.key === panel)?.t}</h3>
              <button className="tv-action-btn" data-focusable="" onClick={() => setPanel(null)}><Icon name="x" size={18} /> 关闭</button>
            </div>
            <div className="tv-sheet-body">
              {panel === 'play' && (
                <>
                  <Row label="自动播放下一集"><TVSwitch on={settings.autoNext} onChange={(v) => update({ autoNext: v })} /></Row>
                  <Row label="硬件解码"><TVSwitch on={settings.hardwareDecode} onChange={(v) => update({ hardwareDecode: v })} /></Row>
                  <Row label="线路自动探测"><TVSwitch on={settings.autoDetectLine} onChange={(v) => update({ autoDetectLine: v })} /></Row>
                  <Row label="默认播放器">
                    <Seg value={settings.defaultPlayer} options={[{ v: 'internal', l: '内置' }, { v: 'external', l: '外部' }]} onChange={(v: any) => update({ defaultPlayer: v })} />
                  </Row>
                  <Row label="画面缩放">
                    <Seg value={settings.videoScale} options={[{ v: 'contain', l: '默认' }, { v: 'cover', l: '铺满' }, { v: 'stretch', l: '拉伸' }]} onChange={(v: any) => update({ videoScale: v })} />
                  </Row>
                  <Row label="默认清晰度">
                    <Seg value={settings.defaultQuality} options={[{ v: 'standard', l: '标清' }, { v: 'high', l: '高清' }, { v: 'lossless', l: '原画' }]} onChange={(v: any) => update({ defaultQuality: v })} />
                  </Row>
                </>
              )}
              {panel === 'look' && (
                <>
                  <Row label="深色模式"><TVSwitch on={settings.darkMode} onChange={(v) => update({ darkMode: v })} /></Row>
                  <div style={{ marginTop: 12 }}>
                    <div className="tv-row-title">皮肤</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 12 }}>
                      {SKINS.concat([{ id: 'auto', name: '自动', swatch: 'linear-gradient(135deg,#0c0e13,#eef0f4)' } as any]).map((s) => (
                        <div
                          key={s.id}
                          className={'tv-set-card' + (selectedId === s.id ? ' active' : '')}
                          data-focusable=""
                          onClick={() => setSkinId(s.id)}
                          role="button"
                          style={{ minHeight: 80 }}
                        >
                          <span className="ic" style={{ height: 28, borderRadius: 8, background: s.swatch }} />
                          <span className="t">{s.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {panel === 'net' && (
                <>
                  <Row label="播放链路走本地代理"><TVSwitch on={settings.useMediaProxy} onChange={(v) => update({ useMediaProxy: v })} /></Row>
                  <Row label="播放诊断浮层"><TVSwitch on={settings.showMediaProbe} onChange={(v) => update({ showMediaProbe: v })} /></Row>
                  <Row label="">
                    <button className="tv-action-btn" data-focusable="" onClick={() => {
                      try { localStorage.clear(); sessionStorage.clear(); clearProxiedCache(); indexedDB.databases?.().then((dbs) => dbs.forEach((d) => d.name && indexedDB.deleteDatabase(d.name))); } catch {}
                      setCacheMsg('已清除缓存'); toast('已清除缓存');
                    }}><Icon name="refresh" size={18} /> 清除缓存</button>
                  </Row>
                  {cacheMsg && <p style={{ color: 'var(--ok)' }}>{cacheMsg}</p>}
                </>
              )}
              {panel === 'about' && (
                <div className="card about-card" style={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 16, padding: 24, textAlign: 'center' }}>
                  <div className="about-logo" style={{ color: 'var(--accent)', fontSize: 34 }}><Icon name="film" size={34} /></div>
                  <div className="about-name" style={{ fontSize: 22, fontWeight: 800 }}>幕海 MuHai</div>
                  <div className="muted sm" style={{ margin: '6px 0' }}>v{appVersion} · 开源本地媒体聚合播放器</div>
                  <p className="sm muted">本软件不提供、存储或分发任何内容，所有资源来自用户自行添加的第三方源。</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 添加源：TV 下用扫码远程推送（清单 §3.8），复用 RemotePushTV */}
      {panel === 'source' && (
        <div className="tv-overlay" data-focus-root>
          <RemotePushTV onClose={() => setPanel(null)} mode="source" />
        </div>
      )}

      {/* 电视模式：手动开关（清单 §3.10 / 风险 #2 兜底） */}
      {panel === 'tv' && (
        <div className="tv-overlay" data-focus-root>
          <div className="tv-sheet">
            <div className="tv-sheet-head">
              <h3>电视模式</h3>
              <button className="tv-action-btn" data-focusable="" onClick={() => setPanel(null)}><Icon name="x" size={18} /> 关闭</button>
            </div>
            <div className="tv-sheet-body">
              <Row label="强制开启电视界面">
                <TVSwitch on={tvMode} onChange={(v) => { setTvMode(v); setManualTvMode(v); toast(v ? '已开启电视模式' : '已恢复自动探测'); }} />
              </Row>
              <p className="muted sm" style={{ lineHeight: 1.7 }}>
                电视 UA 大多不暴露 TV 字样，自动识别可能误判。开启后强制使用遥控器大屏界面；关闭则按设备自动探测（无触摸大屏识别为电视）。
              </p>
            </div>
          </div>
        </div>
      )}

      {showResetConfirm && (
        <div className="tv-overlay" data-focus-root>
          <div className="tv-sheet" style={{ width: 'min(560px,90vw)' }}>
            <div className="tv-sheet-head"><h3 style={{ color: 'var(--danger)' }}>重置软件（清除数据）</h3></div>
            <div className="tv-sheet-body">
              <p style={{ fontSize: 16, lineHeight: 1.7 }}>将清除所有导入的源、观看记录、缓存与登录信息，且<strong>不可恢复</strong>。确定继续吗？</p>
              <div style={{ display: 'flex', gap: 14, marginTop: 16 }}>
                <button className="tv-action-btn" data-focusable="" onClick={() => setShowResetConfirm(false)}>取消</button>
                <button className="tv-action-btn primary" data-focusable="" onClick={() => { setShowResetConfirm(false); onReset(); }}>确定重置</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
