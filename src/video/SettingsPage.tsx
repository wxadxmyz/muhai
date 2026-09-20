import { useEffect, useState } from 'react';
import { useSources } from '../store';
import { useSettings } from '../lib/settings';
import { SubPage } from '../components/SubPage';
import { ImportSourcePage } from '../components/ImportSourcePage';
import { SourceListPage } from '../components/SourceListPage';
import { DownloadManager } from '../components/DownloadManager';
import { DebugPanel } from '../components/DebugPanel';
import { Icon } from '../components/Icon';
import { PlayerSettingsPage } from './PlayerSettingsPage';
import { CloudBrowse } from './views/CloudBrowse';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { clearProxiedCache, proxiedCacheBytes } from '../components/ProxiedImg';
import { checkForUpdate } from '../lib/tauriBridge';
import { useSkin, SKINS } from '../lib/theme';
import { useDownloads, downloadStore } from '../lib/downloads';
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
import { SourceConfig } from '../engine/types';

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} />
  );
}

// ⑥ 长按复制 token（网盘本地登录抓取的 token）
function copyToken(token: string, name: string) {
  if (!token) { toast('该网盘没有可复制的 Token', 'err'); return; }
  const done = () => toast(`已复制 ${name} 的 Token`);
  const fail = () => toast('复制失败，请手动长按选择', 'err');
  try {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(token).then(done).catch(fail);
    else fail();
  } catch { fail(); }
}

// ⑥ 触摸长按手势：返回清理函数；触发时执行 onLong
function useLongPress(onLong: () => void, ms = 600) {
  let timer: number | undefined;
  const start = () => { timer = window.setTimeout(onLong, ms); };
  const clear = () => { if (timer) { window.clearTimeout(timer); timer = undefined; } };
  return { onTouchStart: start, onTouchEnd: clear, onTouchMove: clear, onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onLong(); } };
}

// C3 已挂载网盘行：展示盘名 + 状态，长按/点击复制 token，可移除
function MountRow({ ndKey, token, onCopy, onRemove }: { ndKey: NetdiskKey; token: string; onCopy: () => void; onRemove: () => void }) {
  const p = providerOf(ndKey);
  const lp = useLongPress(onCopy);
  return (
    <div className="netdisk-row" {...lp} onClick={onCopy}>
      <span className="ic"><Icon name="folder" size={26} /></span>
      <div className="nd-body">
        <div className="nd-name">{p.label}</div>
        <div className="sm muted">已获取 Token · 30天</div>
      </div>
      <span className="st ok">已挂载</span>
      <button
        className="nd-remove"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        title="移除该网盘授权"
      >
        移除
      </button>
    </div>
  );
}

function NavRow({
  icon,
  label,
  value,
  onClick,
}: {
  icon: any;
  label: string;
  value?: string;
  onClick: () => void;
}) {
  return (
    <div className="settings-row tap" onClick={onClick}>
      <span className="ico">
        <Icon name={icon} size={20} />
      </span>
      <span className="label">{label}</span>
      {value && <span className="value">{value}</span>}
      <span className="chevron">
        <Icon name="chevron-right" size={18} />
      </span>
    </div>
  );
}

function ToggleRow({
  icon,
  label,
  desc,
  on,
  onChange,
}: {
  icon: any;
  label: string;
  desc?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="settings-row">
      <span className="ico">
        <Icon name={icon} size={20} />
      </span>
      <span className="label">
        {label}
        {desc && <small>{desc}</small>}
      </span>
      <Switch on={on} onChange={onChange} />
    </div>
  );
}

// 兜底版本号：真实版本由 getVersion() 从安装包动态读取；
// #15 版本号自动化：这里改用构建期从 package.json 注入的 __APP_VERSION__，不再手写常量（避免与主版本脱节）。
const APP_VERSION_FALLBACK = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

// 网盘登录页（影视仓样式）：阿里 / 夸克 / UC 三个圆形入口，底层通过 alist 网关注入绑定
const NETDISKS: { key: string; label: string; icon: 'folder'; color: string; desc?: string }[] = [
  { key: 'ali', label: '阿里云盘', icon: 'folder', color: '#6a7cff', desc: '支持 4K 原画' },
  { key: 'quark', label: '夸克网盘', icon: 'folder', color: '#2b6ff2' },
  { key: 'uc', label: 'UC 网盘', icon: 'folder', color: '#ff6a00' },
];

export function SettingsPage({
  onClose,
  sub,
  setSub,
  onReset,
}: {
  onClose?: () => void;
  sub: string | null;
  setSub: (v: string | null) => void;
  onReset?: () => void;
}) {
  const store = useSources('video');
  const { settings, update } = useSettings();
  const [updateState, setUpdateState] = useState<string>('');
  const [checking, setChecking] = useState(false);
  const { skin, selectedId, setSkinId } = useSkin();
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(APP_VERSION_FALLBACK));
  }, []);
  // C3：已挂载网盘 token 状态（本地登录抓取，非 alist）。进入相关子页时刷新一次。
  const [ndTokens, setNdTokens] = useState<Partial<Record<NetdiskKey, string>>>({});
  const refreshNdTokens = () => setNdTokens(getAllNetdiskTokens());
  useEffect(() => { syncNetdiskTokens(); }, []);
  useEffect(() => { if (sub === 'mounts' || sub === 'netdisk') refreshNdTokens(); }, [sub]);

  // ⑬ 首页地区过滤入口已删除（v3.2.0）：内地过滤改由 Home.isDomestic 硬编码规则实现，无需用户维护屏蔽词。

  // ⑪ v3.2.0：清除缓存改为「前端清」——不再调原生 clear_webview_cache（它内部 clear_all_browsing_data
  // 会在部分 ROM 上让 App 被系统回收，表现为"清完回到桌面"）。这里清 localStorage/sessionStorage/
  // ProxiedImg 缓存/IndexedDB，点完立即生效，不提示重启。副标题实时显示缓存大小。
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheMsg, setCacheMsg] = useState('');
  const [cacheSize, setCacheSize] = useState(0);
  const calcCacheSize = () => {
    let bytes = 0;
    try { for (const k in localStorage) bytes += (localStorage[k]?.length || 0) + k.length; } catch { /* ignore */ }
    try { for (const k in sessionStorage) bytes += (sessionStorage[k]?.length || 0) + k.length; } catch { /* ignore */ }
    bytes += proxiedCacheBytes();
    return bytes;
  };
  const fmtCache = (b: number) => {
    if (!b) return '0M';
    const m = b / 1024 / 1024;
    if (m >= 1024) return (m / 1024).toFixed(2) + 'G';
    return (Math.round(m * 10) / 10) + 'M';
  };
  useEffect(() => { setCacheSize(calcCacheSize()); }, []);
  const clearCache = async () => {
    if (cacheBusy) return;
    setCacheBusy(true);
    setCacheMsg('正在清除…');
    try {
      localStorage.clear();
      sessionStorage.clear();
      clearProxiedCache();
      try { indexedDB.databases?.().then((dbs) => dbs.forEach((d) => d.name && indexedDB.deleteDatabase(d.name))); } catch { /* ignore */ }
      setCacheSize(0);
      setCacheMsg('已清除缓存');
    } catch (e: any) {
      setCacheMsg('清除失败：' + (e?.message ?? e));
    } finally {
      setCacheBusy(false);
    }
  };

  // ⑫ v3.2.0：重置确认改用自定义中文 Modal（window.confirm 在部分 ROM 上弹系统原生英文对话框）
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  // 网盘浏览：把「网盘选择下拉」挂到子页顶栏（对齐原型 sp-head 内的 select）
  const [cloudHead, setCloudHead] = useState<React.ReactNode>(null);
  const doReset = () => {
    setShowResetConfirm(false);
    if (resetBusy) return;
    setResetBusy(true);
    try {
      onReset?.(); // 清源 + 清记录 + 清缓存 + 回主页（由 VideoApp 统一处理），不提示重启
    } catch (e: any) {
      setResetMsg('重置失败：' + (e?.message ?? e));
    } finally {
      setResetBusy(false);
    }
  };
  const resetApp = () => {
    if (resetBusy) return;
    setShowResetConfirm(true);
  };

  // 系统返回逐级：先关闭网盘编辑等内部子层，再交还外层（如关闭设置子页），避免直接回主页
  // V3.3.5 B2：旧版这里挂的 __onAndroidBack 是纯 prev 透传（等于没拦），栈式调度下直接删掉，
  // 保留 __settingsInnerBack 供 VideoApp 的 onBackButton 路径询问内部子层。
  useEffect(() => {
    (window as any).__settingsInnerBack = () => false;
    return () => {
      delete (window as any).__settingsInnerBack;
    };
  }, []);

  // C3：是否已在本地抓到该盘 token
  const boundNetdisk = (key: NetdiskKey) => !!getNetdiskToken(key);
  // C3：打开官网登录页，登录后自动抓 token
  const loginNetdisk = async (key: NetdiskKey) => {
    const p = providerOf(key);
    toast(`正在打开 ${p.label} 登录页，登录后自动获取 Token…`);
    const token = await openNetdiskLogin(p);
    refreshNdTokens();
    if (token) toast(`已获取 ${p.label} Token`);
    else toast(`${p.label} 未获取到 Token（可重试）`, 'err');
  };
  const unbindNetdisk = (key: NetdiskKey) => {
    clearNetdiskToken(key);
    refreshNdTokens();
    toast('已移除 ' + providerOf(key).label);
  };

  const count = `${store.sources.length} 个`;
  // V3.5.4：已挂载网盘数量（对齐原型「已挂载列表 2 个」）
  const mountCount = `${Object.values(ndTokens).filter(Boolean).length} 个`;
  // 下载管理实时任务数（导航抽屉 / 设置页入口展示）
  const dlTasks = useDownloads();
  const dlCount = `${dlTasks.length} 个任务`;

  return (
    <>
      <div className="settings-scroll">
        {/* V3.5.4：设置主页完全按「幕海 UI 原型」重构——
            去掉原型中不存在的分组小标题，按原型 6 个卡片分组排布，并补齐
            原型有而旧版缺失的「网盘浏览（alist）」「下载管理」两个入口。 */}

        {/* 组 1：源 */}
        <div className="settings-card">
          <NavRow icon="download" label="导入 json 源" onClick={() => setSub('import')} />
          <NavRow icon="list" label="仓库管理" value={count} onClick={() => setSub('sources')} />
        </div>

        {/* 组 2：网盘（原型 4 项） */}
        <div className="settings-card">
          <NavRow icon="folder" label="网盘登录" onClick={() => setSub('netdisk')} />
          <NavRow icon="library" label="已挂载列表" value={mountCount} onClick={() => setSub('mounts')} />
          <NavRow icon="cloud" label="网盘浏览（alist）" onClick={() => setSub('cloud')} />
          <NavRow icon="download" label="下载管理" value={dlCount} onClick={() => setSub('downloads')} />
        </div>

        {/* 组 3：播放（原型 2 项） */}
        <div className="settings-card">
          <NavRow icon="play" label="播放" onClick={() => setSub('player')} />
          <NavRow icon="download" label="离线缓存" onClick={() => setSub('offline-cache')} />
        </div>

        {/* 组 4：外观 */}
        <div className="settings-card">
          {/* 问题 #7 修复：删除重复的「主题色」入口，皮肤已涵盖深浅色 + 整套配色 */}
          <NavRow icon="palette" label="皮肤" value={skin.name} onClick={() => setSub('skin')} />
          <NavRow icon="camera" label="首页壁纸" onClick={() => setSub('wallpaper')} />
        </div>

        {/* 组 5：更新 / 关于 / 调试 */}
        <div className="settings-card">
          <NavRow
            icon="refresh"
            label="检查更新"
            value={`v${appVersion}`}
            onClick={() => setSub('update')}
          />
          <NavRow icon="file-text" label="关于" onClick={() => setSub('about')} />
          {/* #11：调试面板从悬浮 FAB / 模态移到「检查更新」下方 */}
          <NavRow icon="bug" label="开发者调试" onClick={() => setSub('debug')} />
        </div>

        {/* 组 6：维护（原型把「清除缓存」「重置 APP」合到同一张卡） */}
        <div className="settings-card">
          <div className="settings-row tap" onClick={clearCache}>
            <span className="ico"><Icon name="refresh" size={20} /></span>
            <span className="label">清除缓存</span>
            <span className="value muted">{cacheBusy ? '清除中…' : fmtCache(cacheSize)}</span>
            <span className="chevron"><Icon name="arrow-right" size={18} /></span>
          </div>
          <div className="settings-row danger-row tap" onClick={resetApp}>
            <span className="ico"><Icon name="trash" size={20} /></span>
            <span className="label">重置 APP</span>
            <span className="value muted">{resetBusy ? '重置中…' : '清空所有数据'}</span>
          </div>
          {cacheMsg && <p className="settings-note">{cacheMsg}</p>}
          {resetMsg && <p className="settings-note danger">{resetMsg}</p>}
        </div>
      </div>

      {/* ===== 子页 ===== */}
      {sub === 'import' && (
        <ImportSourcePage mediaType="video" onClose={() => setSub(null)} />
      )}
      {sub === 'sources' && (
        <SourceListPage mediaType="video" title="仓库管理" onClose={() => setSub(null)} onAddSource={() => setSub('import')} />
      )}
      {sub === 'player' && <PlayerSettingsPage onBack={() => setSub(null)} />}

      {sub === 'netdisk' && (
        <SubPage title="网盘登录" onBack={() => setSub(null)}>
          <p className="muted sm nd-tip">登录后在「已挂载列表」中管理授权，可播放网盘内视频。</p>
          {NETDISKS.map((nd) => {
            const bound = boundNetdisk(nd.key as NetdiskKey);
            return (
              <div className="netdisk-row" key={nd.key} onClick={() => loginNetdisk(nd.key as NetdiskKey)}>
                <span className="ic"><Icon name="folder" size={26} /></span>
                <div className="nd-body">
                  <div className="nd-name">{nd.label}</div>
                  {nd.desc && <div className="sm muted">{nd.desc}</div>}
                </div>
                <span className={'st' + (bound ? ' ok' : '')}>{bound ? '已登录' : '点此登录'}</span>
                <span className="ic chev"><Icon name="chevron-right" size={18} /></span>
              </div>
            );
          })}
        </SubPage>
      )}

      {/* V3.5.4：网盘浏览（alist）——原型设置页第 2 组的第三个入口 */}
      {sub === 'cloud' && (
        <SubPage title="网盘浏览" onBack={() => setSub(null)} right={cloudHead}>
          <CloudBrowse
            sources={store.sources}
            onHeadSlot={(n) => setCloudHead(n)}
            onPlayFile={(it) => {
              // 设置页无播放器上下文：有直链则交系统/浏览器，否则提示。
              const url = it.episodes?.[0]?.url;
              if (url) {
                try { window.open(url, '_blank'); } catch { toast('无法打开该文件'); }
              } else {
                toast('该文件暂无可播放直链');
              }
            }}
          />
        </SubPage>
      )}

      {sub === 'mounts' && (
        <SubPage title="已挂载列表" onBack={() => setSub(null)}>
          {(() => {
            const keys = (Object.keys(ndTokens) as NetdiskKey[]).filter((k) => ndTokens[k]);
            if (!keys.length) {
              return (
                <div className="empty">
                  <span className="ic"><Icon name="folder" size={48} /></span>
                  <div className="big">暂无更多已挂载网盘</div>
                  <div className="sm">去「网盘登录」授权更多网盘</div>
                </div>
              );
            }
            return (
              <>
                {keys.map((k) => (
                  <MountRow
                    key={k}
                    ndKey={k}
                    token={ndTokens[k] as string}
                    onCopy={() => copyToken(ndTokens[k] as string, providerOf(k).label)}
                    onRemove={() => unbindNetdisk(k)}
                  />
                ))}
              </>
            );
          })()}
        </SubPage>
      )}

      {sub === 'downloads' && (
        <SubPage
          title="下载管理"
          onBack={() => setSub(null)}
          right={
            <button className="btn sm clear-done" onClick={() => downloadStore.clearDone()}>
              清除已完成
            </button>
          }
        >
          <DownloadManager />
        </SubPage>
      )}

      {sub === 'offline-cache' && (
        <SubPage title="离线缓存" onBack={() => setSub(null)}>
          <div className="set-list">
            <div className="set-line">
              <div className="lbl">默认清晰度</div>
              <div className="pill-sel">
                {([
                  ['standard', '标清'],
                  ['high', '高清'],
                  ['lossless', '原画'],
                ] as const).map(([v, label]) => (
                  <button
                    key={v}
                    className={settings.defaultQuality === v ? 'on' : ''}
                    onClick={() => update({ defaultQuality: v })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="set-line">
              <div className="lbl">并发下载数</div>
              <span className="val">3（固定）</span>
            </div>
          </div>
        </SubPage>
      )}

      {sub === 'skin' && (
        <SubPage title="皮肤" onBack={() => setSub(null)}>
          {/* 版式对齐原型 .skin-grid：3 列方形卡、色条 100%×42px、选中态主色粗描边 */}
          <div className="skin-grid">
            {SKINS.map((s) => (
              <button key={s.id} className={`skin-cell ${selectedId === s.id ? 'on' : ''}`} onClick={() => setSkinId(s.id)}>
                <span className="sw" style={{ background: s.swatch }} />
                {s.name}
              </button>
            ))}
            {/* 「自动」为软件额外提供的跟随系统选项，原型 skin 页没有这一格。
                色条用暗/亮对角半分布，与左右其它格子观感统一（原来 50%/50% 硬切像三角形） */}
            <button className={`skin-cell ${selectedId === 'auto' ? 'on' : ''}`} onClick={() => setSkinId('auto')}>
              <span className="sw" style={{ background: 'linear-gradient(135deg,#0c0e13 0 48%,#eef0f4 52% 100%)' }} />
              自动
            </button>
          </div>
        </SubPage>
      )}

      {sub === 'wallpaper' && (
        <SubPage title="首页壁纸" onBack={() => setSub(null)}>
          {/* 版式对齐原型：小字标签 + 输入框 + 全宽主按钮 */}
          <label className="field-label">壁纸图片 URL</label>
          <input
            className="text-input"
            placeholder="https:// 图片地址（留空则使用默认渐变）"
            value={settings.wallpaper || ''}
            onChange={(e) => update({ wallpaper: e.target.value })}
          />
          <button
            className="primary block"
            style={{ marginTop: 14 }}
            onClick={() => toast(settings.wallpaper ? '壁纸已保存' : '已恢复默认渐变背景')}
          >
            保存
          </button>
        </SubPage>
      )}

      {sub === 'update' && (
        <SubPage title="检查更新" onBack={() => setSub(null)}>
          {/* 版式对齐原型：白卡片内两行版本信息（无下划线）+ 全宽描边按钮 */}
          <div className="card update-card">
            <div className="set-line" style={{ borderBottom: 'none', padding: 0 }}>
              <div className="lbl">当前版本</div>
              <span className="val">v{appVersion}</span>
            </div>
            <div className="set-line" style={{ borderBottom: 'none', padding: '8px 0 0' }}>
              <div className="lbl">最新版本</div>
              <span className="val ok">{checking ? '检查中…' : updateState || `v${appVersion}（已是最新）`}</span>
            </div>
          </div>
          <button
            className="btn block check-update-btn"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              setUpdateState('正在检查…');
              const r = await checkForUpdate();
              setChecking(false);
              if (!r.available) setUpdateState('已是最新版本');
              else if (r.updated) setUpdateState(`已更新至 v${r.version}`);
              else setUpdateState('当前为侧载安装，请在 Release 页手动下载最新 APK。');
            }}
          >
            <Icon name="refresh" size={18} />
            {checking ? '检查中…' : '检查更新'}
          </button>
        </SubPage>
      )}

      {/* #11：开发者调试面板（从悬浮 FAB / 模态改为「检查更新」下方的子页） */}
      {sub === 'debug' && (
        <SubPage title="开发者调试面板" onBack={() => setSub(null)}>
          <DebugPanel />
        </SubPage>
      )}

      {sub === 'about' && (
        <SubPage title="关于" onBack={() => setSub(null)}>
          {/* V3.5.5：与原型 about 1:1 对齐——白色卡片容器 + 渐变圆角 logo +
              「幕海 MuHai」+「vX · 副标题」+ 免责说明，全部居中。 */}
          <div className="card about-card">
            <div className="about-logo"><Icon name="film" size={34} /></div>
            <div className="about-name">幕海 MuHai</div>
            <div className="muted sm about-sub">v{appVersion} · 开源本地媒体聚合播放器</div>
            <p className="sm muted about-desc">
              本软件不提供、存储或分发任何内容，所有资源来自用户自行添加的第三方源。
            </p>
            <div className="muted sm about-foot">使用即代表同意《免责声明》</div>
          </div>
        </SubPage>
      )}

      {/* ⑫ 重置 APP 中文确认 Modal（替代系统原生 window.confirm 英文框） */}
      {showResetConfirm && (
        <div className="modal-mask" onClick={() => setShowResetConfirm(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title" style={{ color: 'var(--danger)' }}>重置 APP</div>
            <div className="modal-text">将清除所有导入的源、观看记录、缓存与登录信息，且<strong>不可恢复</strong>。确定继续吗？</div>
            <div className="modal-btns">
              <button className="modal-btn cancel" onClick={() => setShowResetConfirm(false)}>取消</button>
              <button className="modal-btn danger" onClick={doReset}>确定重置</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
