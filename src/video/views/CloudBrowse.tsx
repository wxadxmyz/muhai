import { useEffect, useState, type ReactNode } from 'react';
import { SourceConfig, MediaItem, uuid } from '../../engine';
import { alistClient, AlistFile } from '../../lib/alistClient';
import { debugLog } from '../../lib/debug';
import { Icon } from '../../components/Icon';
import { toast } from '../../lib/toast';
import {
  getAllNetdiskTokens,
  listNetdiskFiles,
  providerOf,
  type NdFile,
  type NetdiskKey,
} from '../../lib/netdisk';

// ─────────────────────────────────────────────────────────────
// V4.1.3 #7：已登录网盘文件浏览（本地 App 内授权的 ali / quark / uc）
// ─────────────────────────────────────────────────────────────
function Ndbrowser({
  ndKey,
  token,
  onPlayFile,
  onClose,
}: {
  ndKey: NetdiskKey;
  token: string;
  onPlayFile: (item: MediaItem) => void;
  onClose: () => void;
}) {
  const p = providerOf(ndKey);
  // 路径栈：{ id, name }，首页为 root
  const [stack, setStack] = useState<{ id: string; name: string }[]>([
    { id: 'root', name: '根目录' },
  ]);
  const [files, setFiles] = useState<NdFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cur = stack[stack.length - 1];

  useEffect(() => {
    setLoading(true);
    setError(null);
    listNetdiskFiles(ndKey, token, cur.id)
      .then((f) => setFiles(f))
      .catch((e: any) => setError(e?.message ? String(e.message) : '读取失败'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur.id]);

  const VIDEO_RE = /\.(mp4|mkv|mov|avi|flv|wmv|rmvb|ts|m2ts|webm|m3u8)$/i;

  const open = (f: NdFile) => {
    if (f.isDir) {
      setStack((s) => [...s, { id: f.id, name: f.name }]);
    } else if (VIDEO_RE.test(f.name)) {
      const item: MediaItem = {
        id: uuid(),
        sourceId: 'netdisk',
        sourceName: p.label,
        title: f.name.replace(/\.[^.]+$/, ''),
        mediaType: 'video',
        cover: '',
        episodes: [{ name: '正片', url: '' }],
        raw: { fromCloud: true, ndKey },
      };
      onPlayFile(item);
    } else {
      toast('该文件暂不支持在 App 内播放');
    }
  };

  return (
    <div className="view cloud-browse">
      <div className="page-title-row">
        <button className="icon" onClick={onClose}>
          <Icon name="arrow-left" />
        </button>
        <h2 className="page-title">{p.label} 文件</h2>
      </div>
      <div className="breadcrumb">
        <button className="link" onClick={() => setStack([{ id: 'root', name: '根目录' }])}>
          根目录
        </button>
        {stack.slice(1).map((c, i) => (
          <span key={i} className="crumb-seg">
            <Icon name="chevron-right" size={13} />
            <button className="link" onClick={() => setStack((s) => s.slice(0, i + 2))}>
              {c.name}
            </button>
          </span>
        ))}
      </div>

      {loading && <div className="loading">读取目录中…</div>}
      {error && (
        <div className="empty">
          <span className="ic">
            <Icon name="folder" size={48} />
          </span>
          <div className="big">读取失败</div>
          <div className="sm">{error}</div>
          <div className="sm muted">
            阿里/夸克/UC 的个人 API 常需逆向签名鉴权（x-sign / pr / sign），未签名请求可能被服务端拒绝。
            若持续失败，说明该接口未内置签名；可改用「网盘登录」后在影视源中选择网盘线路播放。
          </div>
        </div>
      )}

      <div className="file-grid">
        {!loading && !error && files.length === 0 && (
          <div className="empty" style={{ gridColumn: '1 / -1' }}>
            <span className="ic">
              <Icon name="folder" size={48} />
            </span>
            <div className="big">该目录为空</div>
          </div>
        )}
        {!error &&
          files.map((f) => {
            const isVid = !f.isDir && VIDEO_RE.test(f.name);
            return (
              <div key={f.id} className="file-cell" onClick={() => open(f)}>
                <span className="ic">
                  <Icon name={f.isDir ? 'folder' : isVid ? 'film' : 'file'} size={30} />
                </span>
                <div className="nm">{f.name}</div>
                {!f.isDir && (f.size ?? 0) > 0 && (
                  <div className="nm sz">{((f.size ?? 0) / 1e9).toFixed(2)} GB</div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 网盘浏览主入口：已登录网盘（本地授权）+ alist 云盘浏览
// ─────────────────────────────────────────────────────────────
export function CloudBrowse({
  sources,
  onPlayFile,
  onHeadSlot,
}: {
  sources: SourceConfig[];
  onPlayFile: (item: MediaItem) => void;
  /** 把「网盘选择下拉」挂到子页顶栏（对齐原型：下拉在 sp-head 内）。不传则渲染在内容区。 */
  onHeadSlot?: (node: ReactNode) => void;
}) {
  // V4.1.3 #7：已登录网盘（本地登录抓取的 token）
  const ndTokens = getAllNetdiskTokens();
  const ndKeys = (Object.keys(ndTokens) as NetdiskKey[]).filter((k) => ndTokens[k]);

  const [activeNd, setActiveNd] = useState<NetdiskKey | null>(null);

  const alistSources = sources.filter((s) => s.type === 'alist');
  // V3.7.5 #6：移除写死的「示例网盘(离线演示)」。未配置真实 alist 源时直接显示空态，
  // 不再用演示数据误导用户以为已挂载。
  const effective = alistSources;
  const [srcId, setSrcId] = useState<string>(effective[0]?.id ?? '');
  const [path, setPath] = useState('/');
  const [files, setFiles] = useState<AlistFile[]>([]);
  const [loading, setLoading] = useState(false);

  const cfg = effective.find((s) => s.id === srcId);

  useEffect(() => {
    if (!cfg) {
      setFiles([]);
      return;
    }
    setLoading(true);
    alistClient
      .list(cfg, path)
      .then((f) => setFiles(f))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcId, path]);

  const crumbs = path.split('/').filter(Boolean);

  // 网盘选择下拉：优先挂到子页顶栏（对齐原型），否则就地渲染在标题行
  const picker = (
    <select
      className="text-input nd-pick"
      value={srcId}
      onChange={(e) => {
        setSrcId(e.target.value);
        setPath('/');
      }}
      disabled={effective.length === 0}
    >
      {effective.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
  useEffect(() => {
    onHeadSlot?.(picker);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcId, effective.length]);

  const open = (f: AlistFile) => {
    if (f.isDir) setPath(f.path);
    else if (alistClient.VIDEO_EXT.test(f.name)) {
      const url = cfg ? '' : ''; // 真实直链在播放时再取
      const item: MediaItem = {
        id: uuid(),
        sourceId: cfg?.id ?? 'alist',
        sourceName: cfg?.name ?? '云盘',
        title: f.name.replace(/\.[^.]+$/, ''),
        mediaType: 'video',
        cover: '',
        episodes: [{ name: '正片', url }],
        raw: { alistPath: f.path, fromCloud: true },
      };
      onPlayFile(item);
    }
  };

  // V4.1.5 ⑥：已登录网盘浏览（Ndbrowser）放到**所有 hook 之后**再条件返回，
  // 否则点进去后 hook 数量骤减会触发 React #300 渲染错误。
  if (activeNd) {
    return (
      <Ndbrowser
        ndKey={activeNd}
        token={ndTokens[activeNd] as string}
        onPlayFile={onPlayFile}
        onClose={() => setActiveNd(null)}
      />
    );
  }

  return (
    <div className="view cloud-browse">
      {/* V4.1.3 #7：已登录网盘入口（App 内授权的 ali / quark / uc） */}
      {ndKeys.length > 0 && (
        <div className="nd-logged-block">
          <div className="muted sm" style={{ margin: '4px 0 8px' }}>
            已登录网盘（App 内授权）
          </div>
          {ndKeys.map((k) => (
            <div key={k} className="netdisk-row" onClick={() => setActiveNd(k)}>
              <span className="ic">
                <Icon name="folder" size={26} />
              </span>
              <div className="nd-body">
                <div className="nd-name">{providerOf(k).label}</div>
                <div className="sm muted">点此浏览文件</div>
              </div>
              <span className="st ok">已挂载</span>
              <span className="ic chev">
                <Icon name="chevron-right" size={18} />
              </span>
            </div>
          ))}
        </div>
      )}

      {!onHeadSlot && (
        <div className="page-title-row">
          <h2 className="page-title">网盘浏览</h2>
          {picker}
        </div>
      )}
      <p className="muted sm cb-tip">
        像文件管理器一样逛挂载的网盘。点击文件夹进入，点击视频文件直接播放（需真实 alist 源提供直链）。
      </p>

      {/* 面包屑（对齐原型：根目录 › 影视 › 剧集） */}
      <div className="breadcrumb">
        <button className="link" onClick={() => setPath('/')}>
          根目录
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="crumb-seg">
            <Icon name="chevron-right" size={13} />
            <button className="link" onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>
              {c}
            </button>
          </span>
        ))}
      </div>

      {loading && <div className="loading">读取目录中…</div>}
      <div className="file-grid">
        {files.length === 0 && !loading && (
          <div className="empty" style={{ gridColumn: '1 / -1' }}>
            <span className="ic">
              <Icon name="folder" size={48} />
            </span>
            <div className="big">该目录为空</div>
            <div className="sm">
              这是 alist 云盘浏览区。若想在 App 内直接看刚登录的阿里/夸克/UC，请到「设置 → 网盘登录」查看已挂载网盘；
              此处需先在「影视源管理」添加一个 alist 源（自备 alist 服务地址与账号）才能浏览文件。
            </div>
          </div>
        )}
        {files.map((f) => {
          const isVid = !f.isDir && alistClient.VIDEO_EXT.test(f.name);
          return (
            <div key={f.path} className="file-cell" onClick={() => open(f)}>
              <span className="ic">
                <Icon name={f.isDir ? 'folder' : isVid ? 'film' : 'file'} size={30} />
              </span>
              <div className="nm">{f.name}</div>
              {!f.isDir && (f.size ?? 0) > 0 && (
                <div className="nm sz">{((f.size ?? 0) / 1e9).toFixed(2)} GB</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
