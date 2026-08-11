import { useEffect, useState } from 'react';
import { SourceConfig, MediaItem, uuid } from '../../engine';
import { alistClient, AlistFile } from '../../lib/alistClient';
import { debugLog } from '../../lib/debug';
import { Icon } from '../../components/Icon';

export function CloudBrowse({
  sources,
  onPlayFile,
}: {
  sources: SourceConfig[];
  onPlayFile: (item: MediaItem) => void;
}) {
  const alistSources = sources.filter((s) => s.type === 'alist');
  // 未配置真实 alist 源时，使用一个内置示例盘，保证开箱即可体验文件浏览（仅为演示数据）
  const DEMO: SourceConfig = { id: '__demo_alist__', name: '示例网盘(离线演示)', type: 'alist', baseUrl: '', enabled: true, priority: 0 };
  const effective = alistSources.length > 0 ? alistSources : [DEMO];
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
      <div className="page-title-row">
        <h2 className="page-title">网盘浏览（alist）</h2>
        <select value={srcId} onChange={(e) => { setSrcId(e.target.value); setPath('/'); }} disabled={effective.length === 0}>
          {effective.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      {alistSources.length === 0 && <p className="muted sm hint-demo">当前为内置示例盘（演示数据，不可播放真实内容）。在「音源管理」添加一个真实的 alist 源（baseUrl + Token）即可浏览并播放你的网盘。</p>}
      <p className="muted sm">像文件管理器一样逛你挂载的网盘（阿里云盘/夸克/UC/115…）。未填真实 alist 地址时显示示例文件。点击视频文件即可播放（需真实 alist 提供直链）。</p>

      <div className="breadcrumb">
        <button className="link" onClick={() => setPath('/')}>根目录</button>
        {crumbs.map((c, i) => (
          <span key={i}>
            <span className="sep">/</span>
            <button className="link" onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button>
          </span>
        ))}
      </div>

      {loading && <div className="loading">读取目录中…</div>}
      <div className="cloud-grid">
        {files.length === 0 && !loading && <div className="empty">该目录为空，或尚未配置云盘源（在音源管理里添加一个 alist 源）。</div>}
        {files.map((f) => (
          <button key={f.path} className={'cloud-item' + (f.isDir ? ' dir' : ' file')} onClick={() => open(f)}>
            <span className="ci-ico"><Icon name={f.isDir ? 'folder' : alistClient.VIDEO_EXT.test(f.name) ? 'film' : 'file'} size={20} /></span>
            <span className="ci-name">{f.name}</span>
            {!f.isDir && f.size && <span className="ci-size">{(f.size / 1e9).toFixed(2)} GB</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
