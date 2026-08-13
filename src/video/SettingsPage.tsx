import { useState } from 'react';
import { useSources } from '../store';
import { useSettings } from '../lib/settings';
import { SubPage } from '../components/SubPage';
import { ImportSourcePage } from '../components/ImportSourcePage';
import { SourceListPage } from '../components/SourceListPage';
import { Icon } from '../components/Icon';
import { PlayerSettingsPage } from './PlayerSettingsPage';
import { checkForUpdate } from '../lib/tauriBridge';

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} />
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

const ACCENTS = ['#4f8cff', '#ff5d73', '#23c08b', '#ff9f43', '#a66bff', '#1ec8e8', '#f4b2c0', '#ff6b9d'];

const APP_VERSION = '1.2.3';

// 网盘登录页（影视仓样式）：阿里 / 夸克 / UC 三个圆形入口，底层通过 alist 网关注入绑定
const NETDISKS = [
  { key: 'ali', label: '阿里网盘', icon: 'folder' as const, color: '#6a7cff' },
  { key: 'quark', label: '夸克网盘', icon: 'folder' as const, color: '#2b6ff2' },
  { key: 'uc', label: 'UC网盘', icon: 'folder' as const, color: '#ff6a00' },
];

export function SettingsPage({ onClose }: { onClose?: () => void }) {
  const store = useSources('video');
  const { settings, update } = useSettings();
  const [sub, setSub] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<string>('');
  const [checking, setChecking] = useState(false);
  const [editingNetdisk, setEditingNetdisk] = useState<string | null>(null);
  const [ndForm, setNdForm] = useState({ name: '', baseUrl: '', token: '', mountPath: '/' });

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

  const applyTheme = (c: string) => {
    document.documentElement.style.setProperty('--accent', c);
    document.documentElement.style.setProperty('--accent2', c);
    update({ themeColor: c });
  };

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
          <NavRow icon="list" label="源列表" value={count} onClick={() => setSub('sources')} />
          <NavRow icon="sliders" label="切换站点" onClick={() => setSub('switchsite')} />
        </div>

        {/* 网盘 */}
        <div className="settings-group-title">网盘</div>
        <div className="settings-card">
          <NavRow icon="library" label="网盘登录" value="阿里 / 夸克 / WebDAV" onClick={() => setSub('netdisk')} />
          <NavRow icon="folder" label="已挂载列表" onClick={() => setSub('mounts')} />
        </div>

        {/* 播放 */}
        <div className="settings-group-title">播放</div>
        <div className="settings-card">
          <NavRow icon="play" label="播放" onClick={() => setSub('player')} />
        </div>

        {/* 直播 */}
        <div className="settings-group-title">直播</div>
        <div className="settings-card">
          <NavRow icon="clock" label="EPG 节目单" onClick={() => setSub('epg')} />
          <NavRow icon="film" label="直播源分组" onClick={() => setSub('livetv')} />
        </div>

        {/* 下载 */}
        <div className="settings-group-title">下载</div>
        <div className="settings-card">
          <NavRow icon="download" label="离线缓存" value="路径 / 清晰度 / 并发" onClick={() => setSub('downloads')} />
        </div>

        {/* 外观 */}
        <div className="settings-group-title">外观</div>
        <div className="settings-card">
          <NavRow icon="palette" label="主题色" value={settings.themeColor || '蓝'} onClick={() => setSub('theme')} />
          <ToggleRow icon="sliders" label="深色模式" on={settings.darkMode} onChange={(v) => update({ darkMode: v })} />
          <NavRow icon="camera" label="首页壁纸" onClick={() => setSub('wallpaper')} />
        </div>

        {/* 通用 */}
        <div className="settings-group-title">通用</div>
        <div className="settings-card">
          <NavRow
            icon="download"
            label="检查更新"
            value={`v${APP_VERSION}`}
            onClick={() => setSub('update')}
          />
          <NavRow icon="file-text" label="关于" onClick={() => setSub('about')} />
        </div>
      </div>

      {/* ===== 子页 ===== */}
      {sub === 'import' && (
        <ImportSourcePage mediaType="video" onClose={() => setSub(null)} />
      )}
      {sub === 'sources' && (
        <SourceListPage mediaType="video" title="源列表" onClose={() => setSub(null)} />
      )}
      {sub === 'switchsite' && (
        <SourceListPage mediaType="video" title="切换站点" onClose={() => setSub(null)} />
      )}
      {sub === 'player' && <PlayerSettingsPage onBack={() => setSub(null)} />}

      {sub === 'netdisk' && (
        <SubPage title="网盘登录" onBack={() => setSub(null)}>
          <div className="netdisk-grid">
            {NETDISKS.map((nd) => {
              const bound = boundNetdisk(nd.key);
              return (
                <div
                  className={'netdisk-item' + (editingNetdisk === nd.key ? ' active' : '')}
                  key={nd.key}
                  onClick={() => setEditingNetdisk(nd.key)}
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
                </div>
              );
            }
            return (
              <div className="settings-card">
                {list.map((s) => (
                  <div className="settings-row" key={s.id}>
                    <span className="ico"><Icon name="folder" size={20} /></span>
                    <span className="label">{s.name || s.baseUrl}</span>
                    <span className="value muted">{s.baseUrl}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </SubPage>
      )}

      {sub === 'epg' && (
        <SubPage title="EPG 节目单" onBack={() => setSub(null)}>
          <p className="settings-note">直播节目单将在添加直播源后自动更新。当前未配置直播源。</p>
        </SubPage>
      )}

      {sub === 'livetv' && (
        <SubPage title="直播源分组" onBack={() => setSub(null)}>
          <p className="settings-note">直播功能需配置相应的直播源（m3u / txt）。当前未配置。</p>
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

      {sub === 'theme' && (
        <SubPage title="主题色" onBack={() => setSub(null)}>
          <div className="settings-card">
            <div className="settings-row">
              <span className="ico">
                <Icon name="palette" size={20} />
              </span>
              <span className="label">选择强调色</span>
            </div>
            <div className="skin-grid">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  className={`skin-cell ${settings.themeColor === c ? 'active' : ''}`}
                  style={{ background: c }}
                  onClick={() => applyTheme(c)}
                />
              ))}
            </div>
          </div>
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
              <span className="value">v{APP_VERSION}</span>
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
              else setUpdateState('发现新版本，但当前为侧载包，请手动下载更新。');
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
            <h2>影流 ReelFlow</h2>
            <p className="muted">版本 v{APP_VERSION}</p>
            <p className="about-desc">
              一款开源的本地媒体聚合播放工具，内容来自用户自行添加的第三方源，软件本身不提供任何资源。
            </p>
            <p className="muted sm">使用即代表同意《免责声明》。</p>
          </div>
        </SubPage>
      )}
    </>
  );
}
