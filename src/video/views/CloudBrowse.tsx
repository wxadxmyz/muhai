import { useEffect, useState, type ReactNode } from 'react';
import { SourceConfig, MediaItem, uuid } from '../../engine';
import { alistClient, AlistFile } from '../../lib/alistClient';
import { debugLog } from '../../lib/debug';
import { Icon } from '../../components/Icon';

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
      onChange={(e) => { setSrcId(e.target.value); setPath('/'); }}
      disabled={effective.length === 0}
    >
      {effective.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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

  return (
    <div className="view cloud-browse">
      {/* 内容区标题：仅在未挂顶栏时显示（避免与子页标题重复） */}
      {!onHeadSlot && (
        <div className="page-title-row">
          <h2 className="page-title">网盘浏览</h2>
          {picker}
        </div>
      )}
      <p className="muted sm cb-tip">像文件管理器一样逛挂载的网盘。点击文件夹进入，点击视频文件直接播放（需真实 alist 源提供直链）。</p>

      {/* 面包屑（对齐原型：根目录 › 影视 › 剧集） */}
      <div className="breadcrumb">
        <button className="link" onClick={() => setPath('/')}>根目录</button>
        {crumbs.map((c, i) => (
          <span key={i} className="crumb-seg">
            <Icon name="chevron-right" size={13} />
            <button className="link" onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button>
          </span>
        ))}
      </div>

      {loading && <div className="loading">读取目录中…</div>}
      <div className="file-grid">
        {files.length === 0 && !loading && (
          <div className="empty" style={{ gridColumn: '1 / -1' }}>
            <span className="ic"><Icon name="folder" size={48} /></span>
            <div className="big">该目录为空</div>
            <div className="sm">尚未配置云盘源，可在「影视源管理」添加一个 alist 源</div>
          </div>
        )}
        {files.map((f) => {
          const isVid = !f.isDir && alistClient.VIDEO_EXT.test(f.name);
          return (
            <div key={f.path} className="file-cell" onClick={() => open(f)}>
              <span className="ic"><Icon name={f.isDir ? 'folder' : isVid ? 'film' : 'file'} size={30} /></span>
              <div className="nm">{f.name}</div>
              {!f.isDir && (f.size ?? 0) > 0 && <div className="nm sz">{((f.size ?? 0) / 1e9).toFixed(2)} GB</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
