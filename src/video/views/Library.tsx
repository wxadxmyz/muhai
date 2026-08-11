import { useState } from 'react';
import { useLibrary } from '../../lib/library';
import { MediaItem } from '../../engine/types';
import { gradientFor, initial } from '../../lib/cover';
import { DownloadManager } from '../../components/DownloadManager';
import { Icon } from '../../components/Icon';

export function VideoLibrary({
  library,
  onOpen,
  onOpenDebug,
}: {
  library: ReturnType<typeof useLibrary>;
  onOpen: (it: MediaItem) => void;
  onOpenDebug?: () => void;
}) {
  const [tab, setTab] = useState<'history' | 'fav' | 'download'>('history');

  const Row = ({ items, showProgress }: { items: MediaItem[]; showProgress?: boolean }) => (
    <div className="track-list video">
      {items.length === 0 && <div className="muted sm">这里还是空的。</div>}
      {items.map((it) => {
        const prog = library.lib.watchProgress[`${it.sourceId}:${it.id}`] ?? 0;
        const pct = it.duration ? Math.round((prog / it.duration) * 100) : 0;
        return (
          <div className="track-row" key={it.sourceId + it.id} onDoubleClick={() => onOpen(it)}>
            <span className="tcover" style={{ background: it.cover ? undefined : gradientFor(it.title) }}>
              {it.cover ? <img src={it.cover} alt="" /> : initial(it.title)}
            </span>
            <span className="ttitle" onClick={() => onOpen(it)}>{it.title}</span>
            <span className="tsub">{it.year ?? ''} {it.genre ? '· ' + it.genre : ''}</span>
            {showProgress && <span className="tprog"><span className="tprog-in" style={{ width: pct + '%' }} /></span>}
            <span className="tactions">
              <button className="mini" onClick={() => onOpen(it)}><Icon name="play" size={16} /></button>
              <button className="mini" onClick={() => library.toggleFavorite(it)} title="收藏"><Icon name={library.isFavorite(it) ? 'heart-filled' : 'heart'} size={16} /></button>
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="view library">
      <div className="page-title-row">
        <h2 className="page-title">我的影视</h2>
        {onOpenDebug && <button className="mobile-only" onClick={onOpenDebug}><Icon name="bug" size={16} /> 调试</button>}
      </div>
      <div className="tabs">
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>观看历史</button>
        <button className={tab === 'fav' ? 'active' : ''} onClick={() => setTab('fav')}>我的收藏</button>
        <button className={tab === 'download' ? 'active' : ''} onClick={() => setTab('download')}>下载</button>
      </div>

      {tab === 'history' && (
        <>
          <div className="toolbar"><button className="link" onClick={() => library.clearHistory()}>清空历史</button></div>
          <Row items={library.lib.history.filter((i) => i.mediaType === 'video')} showProgress />
        </>
      )}
      {tab === 'fav' && <Row items={library.lib.favorites.filter((i) => i.mediaType === 'video')} />}
      {tab === 'download' && <DownloadManager title="下载管理（影视）" />}
    </div>
  );
}
