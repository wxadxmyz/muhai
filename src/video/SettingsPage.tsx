import { useEffect, useState } from 'react';
import { useSources } from '../store';
import { useSettings } from '../lib/settings';
import { SubPage } from '../components/SubPage';
import { ImportSourcePage } from '../components/ImportSourcePage';
import { SourceListPage } from '../components/SourceListPage';
import { Icon } from '../components/Icon';
import { PlayerSettingsPage } from './PlayerSettingsPage';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { clearProxiedCache, proxiedCacheBytes } from '../components/ProxiedImg';
import { checkForUpdate } from '../lib/tauriBridge';
import { useSkin, SKINS } from '../lib/theme';
import { toast } from '../lib/toast';
import { alistClient, AlistStorage } from '../lib/alistClient';
import { SourceConfig } from '../engine/types';

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} />
  );
}

// ⑥ 打开网盘登录页（系统浏览器 / 外部浏览器）
function openExternal(url: string) {
  try { window.open(url, '_blank'); } catch { /* ignore */ }
}

// ⑥ 长按复制 token（alist 网关 token）
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

// ⑥ 已挂载列表的单个网关行：展示挂载路径 + 已挂的盘，长按/点击复制 Token
function MountRow({ s, drives }: { s: SourceConfig; drives: AlistStorage[] }) {
  const lp = useLongPress(() => copyToken(s.token || '', s.name || s.baseUrl));
  return (
    <div>
      <div
        className="settings-row copyable"
        {...lp}
        onClick={() => { if (s.token) copyToken(s.token, s.name || s.baseUrl); }}
      >
        <span className="ico"><Icon name="folder" size={20} /></span>
        <span className="label">{s.name || s.baseUrl}</span>
        <span className="value muted">{s.baseUrl}</span>
      </div>
      {drives.length > 0 && (
        <div className="mount-drives">
          {drives.map((d) => (
            <span className="drive-chip" key={d.id}>
              {d.driver || '盘'}{d.mountPath && d.mountPath !== '/' ? ` · ${d.mountPath}` : ''}
            </span>
          ))}
        </div>
      )}
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
        <Icon name="arrow-right" size={18} />
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

// 兜底版本号：真实版本由 getVersion() 从安装包动态读取，避免显示写死旧版
const APP_VERSION_FALLBACK = '2.3.10';

// 网盘登录页（影视仓样式）：阿里 / 夸克 / UC 三个圆形入口，底层通过 alist 网关注入绑定
const NETDISKS = [
  { key: 'ali', label: '阿里网盘', icon: 'folder' as const, color: '#6a7cff' },
  { key: 'quark', label: '夸克网盘', icon: 'folder' as const, color: '#2b6ff2' },
  { key: 'uc', label: 'UC网盘', icon: 'folder' as const, color: '#ff6a00' },
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
  const [editingNetdisk, setEditingNetdisk] = useState<string | null>(null);
  const [ndForm, setNdForm] = useState({ name: '', baseUrl: '', token: '', mountPath: '/' });
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(APP_VERSION_FALLBACK));
  }, []);

  // ⑥：已挂载列表——每个 alist 网关下实际挂了哪些盘（驱动名 + 挂载路径），供"长按复制 Token"之外展示
  const [storages, setStorages] = useState<Record<string, AlistStorage[]>>({});
  useEffect(() => {
    if (sub !== 'mounts') return;
    let alive = true;
    const list = store.sources.filter((s) => s.type === 'alist');
    Promise.all(list.map((s) => alistClient.listStorages(s).then((d) => [s.id, d] as const)))
      .then((entries) => { if (alive) setStorages(Object.fromEntries(entries)); })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, store.sources]);

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
  useEffect(() => {
    const prev = (window as any).__onAndroidBack;
    (window as any).__onAndroidBack = () => {
      if (editingNetdisk) { setEditingNetdisk(null); return false; }
      return typeof prev === 'function' ? prev() : true;
    };
    // 问题 #8 修复：向 VideoApp 的 Tauri onBackButton 路径暴露"是否有内部子层可逐级退出"。
    // 否则在 settingsSub 且 editingNetdisk 时，onBackButton 会直接 setSettingsSub(null) 跳回主页。
    (window as any).__settingsInnerBack = () => {
      if (editingNetdisk) { setEditingNetdisk(null); return true; }
      return false;
    };
    return () => {
      (window as any).__onAndroidBack = prev;
      delete (window as any).__settingsInnerBack;
    };
  }, [editingNetdisk]);

  const boundNetdisk = (key: string) => {
    const label = NETDISKS.find((n) => n.key === key)?.label ?? '';
    return store.sources.some((s) => s.type === 'alist' && s.name.includes(label));
  };
  const saveNetdisk = () => {
    if (!ndForm.baseUrl.trim()) return;
    const label = NETDISKS.find((n) => n.key === editingNetdisk)?.label ?? '网盘';
    store.add({
      name: ndForm.name.trim() || label,
      type: 'alist',
      baseUrl: ndForm.baseUrl.trim(),
      token: ndForm.token.trim() || undefined,
      mountPath: ndForm.mountPath.trim() || '/',
    });
    setNdForm({ name: '', baseUrl: '', token: '', mountPath: '/' });
    setEditingNetdisk(null);
  };

  const count = `${store.sources.length} 个`;

  return (
    <>
      <div className="settings-scroll">
        {/* 源管理 */}
        <div className="settings-group-title">源管理</div>
        <div className="settings-card">
          <NavRow
            icon="download"
            label="导入 json 源"
            value="手动地址 / 扫码"
            onClick={() => setSub('import')}
          />
          <NavRow icon="list" label="仓库管理" value={count} onClick={() => setSub('sources')} />
        </div>

        {/* 网盘 */}
        <div className="settings-group-title">网盘</div>
        <div className="settings-card">
          <NavRow icon="library" label="网盘登录" value="阿里 / 夸克 / UC" onClick={() => setSub('netdisk')} />
          <NavRow icon="folder" label="已挂载列表" onClick={() => setSub('mounts')} />
        </div>

        {/* 播放 */}
        <div className="settings-group-title">播放</div>
        <div className="settings-card">
          <NavRow icon="play" label="播放" onClick={() => setSub('player')} />
        </div>

        {/* 下载 */}
        <div className="settings-group-title">下载</div>
        <div className="settings-card">
          <NavRow icon="download" label="离线缓存" value="路径 / 清晰度 / 并发" onClick={() => setSub('downloads')} />
        </div>

        {/* 外观 */}
        <div className="settings-group-title">外观</div>
        <div className="settings-card">
          {/* 问题 #7 修复：删除重复的「主题色」入口，皮肤已涵盖深浅色 + 整套配色；主题色仅改 --accent 与之重叠 */}
          <NavRow icon="sliders" label="皮肤" value={skin.name} onClick={() => setSub('skin')} />
          <NavRow icon="camera" label="首页壁纸" onClick={() => setSub('wallpaper')} />
        </div>

        {/* 通用 */}
        <div className="settings-group-title">通用</div>
        <div className="settings-card">
          <NavRow
            icon="download"
            label="检查更新"
            value={`v${appVersion}`}
            onClick={() => setSub('update')}
          />
          <NavRow icon="file-text" label="关于" onClick={() => setSub('about')} />
        </div>

        {/* 维护 */}
        <div className="settings-group-title">维护</div>
        <div className="settings-card">
          <div className="settings-row danger-row" onClick={clearCache}>
            <span className="ico"><Icon name="refresh" size={20} /></span>
            <span className="label">清除缓存</span>
            <span className="value muted">{cacheBusy ? '清除中…' : fmtCache(cacheSize)}</span>
            <span className="chevron"><Icon name="arrow-right" size={18} /></span>
          </div>
          <div className="settings-row danger-row" onClick={resetApp}>
            <span className="ico"><Icon name="trash" size={20} /></span>
            <span className="label">重置 APP</span>
            <span className="value muted">{resetBusy ? '重置中…' : '清空所有数据'}</span>
            <span className="chevron"><Icon name="arrow-right" size={18} /></span>
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
        <SourceListPage mediaType="video" title="仓库管理" onClose={() => setSub(null)} />
      )}
      {sub === 'player' && <PlayerSettingsPage onBack={() => setSub(null)} />}

      {sub === 'netdisk' && (
        <SubPage title="网盘登录" onBack={() => setSub(null)}>
          <div className="netdisk-grid">
            {NETDISKS.map((nd) => {
              const bound = boundNetdisk(nd.key);
              const gw = store.sources.find((s) => s.type === 'alist' && s.name.includes(nd.label));
              return (
                <div
                  className={'netdisk-item' + (editingNetdisk === nd.key ? ' active' : '')}
                  key={nd.key}
                  onClick={() => {
                    // ⑥：已绑定且填了 alist 地址 → 直接打开该盘的登录/挂载页（官网登录页由 alist 后台承接）；
                    //    未绑定 → 展开手动填 alist 地址 + Token 的表单
                    if (gw?.baseUrl) { openExternal(gw.baseUrl); toast('已打开 ' + nd.label + ' 登录页'); }
                    else setEditingNetdisk(nd.key);
                  }}
                >
                  <div className="nd-icon" style={{ background: nd.color }}>
                    <Icon name={nd.icon} size={24} />
                  </div>
                  <div className="nd-name">{nd.label}</div>
                  <div className={'nd-state' + (bound ? ' ok' : '')}>{bound ? '已绑定' : '未绑定'}</div>
                </div>
              );
            })}
          </div>

          {editingNetdisk && (
            <div className="netdisk-form">
              <h4>绑定{NETDISKS.find((n) => n.key === editingNetdisk)?.label}</h4>
              <p className="muted sm">
                本机通过 alist 网关注入网盘（阿里 / 夸克 / UC 均支持）。在 alist 后台挂载对应网盘后，
                填好下面的 alist 地址与 Token 保存，即可浏览 / 搜索 / 播放网盘视频，之后播放无需重复登录。
              </p>
              <label>名称</label>
              <input value={ndForm.name} onChange={(e) => setNdForm({ ...ndForm, name: e.target.value })} placeholder="留空自动命名" />
              <label>alist 地址</label>
              <input value={ndForm.baseUrl} onChange={(e) => setNdForm({ ...ndForm, baseUrl: e.target.value })} placeholder="http://192.168.x.x:5244" />
              <label>Token（alist 管理 Token）</label>
              <input value={ndForm.token} onChange={(e) => setNdForm({ ...ndForm, token: e.target.value })} placeholder="alist-xxx" />
              <label>挂载目录（可选）</label>
              <input value={ndForm.mountPath} onChange={(e) => setNdForm({ ...ndForm, mountPath: e.target.value })} placeholder="/" />
              <button className="primary block" onClick={saveNetdisk}>保存并绑定</button>
            </div>
          )}

          <p className="settings-note">也可到「源列表 → 添加源」，类型选「云盘(alist)」手动添加。</p>
        </SubPage>
      )}

      {sub === 'mounts' && (
        <SubPage title="已挂载列表" onBack={() => setSub(null)}>
          {(() => {
            const list = store.sources.filter((s) => s.type === 'alist');
            if (!list.length) {
              return (
                <div className="empty-hint">
                  <Icon name="folder" size={40} />
                  <p>暂无可挂载的网盘</p>
                  <p className="muted sm">先到「网盘登录」绑定 alist 地址与 Token</p>
                </div>
              );
            }
            return (
              <div className="settings-card">
                {list.map((s) => (
                  <MountRow key={s.id} s={s} drives={storages[s.id] || []} />
                ))}
              </div>
            );
          })()}
          <p className="settings-note">长按网盘条目即可复制其 Token（alist 网关 Token）。已挂载的盘由 alist 管理接口读取，需管理员 Token。</p>
        </SubPage>
      )}

      {sub === 'downloads' && (
        <SubPage title="离线缓存" onBack={() => setSub(null)}>
          <div className="settings-card">
            <div className="settings-row">
              <span className="ico">
                <Icon name="download" size={20} />
              </span>
              <span className="label">默认清晰度</span>
              <select
                className="value-select"
                value={settings.defaultQuality}
                onChange={(e) => update({ defaultQuality: e.target.value as any })}
              >
                <option value="standard">标清</option>
                <option value="high">高清</option>
                <option value="lossless">原画</option>
              </select>
            </div>
            <div className="settings-row">
              <span className="ico">
                <Icon name="sliders" size={20} />
              </span>
              <span className="label">并发下载数</span>
              <span className="value">3</span>
            </div>
          </div>
          <p className="settings-note">离线缓存路径在桌面端设置中指定，移动端默认保存在应用私有目录。</p>
        </SubPage>
      )}

      {sub === 'skin' && (
        <SubPage title="皮肤" onBack={() => setSub(null)}>
          <div className="settings-card">
            <div className="settings-row">
              <span className="ico">
                <Icon name="sliders" size={20} />
              </span>
              <span className="label">选择皮肤（深色 / 浅色）</span>
            </div>
            <div className="skin-grid">
              <button key="auto" className={`skin-cell ${selectedId === 'auto' ? 'active' : ''}`} onClick={() => setSkinId('auto')}>
                <span className="skin-swatch" style={{ background: 'linear-gradient(135deg,#1e2230 50%,#f4f5f9 50%)' }} />
                <span className="skin-name">自动</span>
              </button>
              {SKINS.map((s) => (
                <button key={s.id} className={`skin-cell ${selectedId === s.id ? 'active' : ''}`} onClick={() => setSkinId(s.id)}>
                  <span className="skin-swatch" style={{ background: s.swatch }} />
                  <span className="skin-name">{s.name}</span>
                </button>
              ))}
            </div>
          </div>
          <p className="settings-note">浅色皮肤：樱花粉 / 薄荷绿 / 落日橙 等；深色皮肤：暗夜黑 / 极光蓝 / 葡萄紫 / 火山红。「自动」跟随系统明暗。</p>
        </SubPage>
      )}

      {sub === 'wallpaper' && (
        <SubPage title="首页壁纸" onBack={() => setSub(null)}>
          <div className="settings-card">
            <div className="settings-row">
              <span className="ico">
                <Icon name="camera" size={20} />
              </span>
              <span className="label">壁纸地址（图片 URL）</span>
            </div>
            <input
              className="text-input full"
              placeholder="https://..."
              value={settings.wallpaper || ''}
              onChange={(e) => update({ wallpaper: e.target.value })}
            />
          </div>
          <p className="settings-note">填写图片地址后，首页将以该图片作为背景（建议暗色、低对比度图片）。</p>
        </SubPage>
      )}

      {sub === 'update' && (
        <SubPage title="检查更新" onBack={() => setSub(null)}>
          <div className="settings-card">
            <div className="settings-row">
              <span className="ico">
                <Icon name="download" size={20} />
              </span>
              <span className="label">当前版本</span>
              <span className="value">v{appVersion}</span>
            </div>
          </div>
          <button
            className="primary block"
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
            {checking ? '检查中…' : '检查更新'}
          </button>
          {updateState && <p className="settings-note">{updateState}</p>}
        </SubPage>
      )}

      {sub === 'about' && (
        <SubPage title="关于" onBack={() => setSub(null)}>
          <div className="about-box">
            <h2>幕海 MuHai</h2>
            <p className="muted">版本 v{appVersion}</p>
            <p className="about-desc">
              一款开源的本地媒体聚合播放工具，内容来自用户自行添加的第三方源，软件本身不提供任何资源。
            </p>
            <p className="muted sm">使用即代表同意《免责声明》。</p>
          </div>
        </SubPage>
      )}

      {/* ⑫ 重置 APP 中文确认 Modal（替代系统原生 window.confirm 英文框） */}
      {showResetConfirm && (
        <div className="modal-mask" onClick={() => setShowResetConfirm(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">重置 APP</div>
            <div className="modal-text">确定要重置吗？将清空所有源、历史与设置，且不可恢复。</div>
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
