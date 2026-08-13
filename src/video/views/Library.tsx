import { useLibrary } from '../../lib/library';
import { MediaItem } from '../../engine/types';
import { gradientFor, initial } from '../../lib/cover';
import { Icon } from '../../components/Icon';

export function VideoLibrary({
  library,
  onOpen,
  onSearch,
}: {
  library: ReturnType<typeof useLibrary>;
  onOpen: (it: MediaItem) => void;
  onSearch?: (kw: string) => void;
}) {
  const historyItems = library.lib.history.filter((i) => i.mediaType === 'video');
  const searchItems = library.lib.searchHistory;

  return (
    <div className="view library">
      <div className="page-title-row">
        <h2 className="page-title">历史</h2>
      </div>

      <div className="row-head"><h3>观看历史</h3></div>
      <div className="track-list video">
        {historyItems.length === 0 && <div className="muted sm">还没有观看记录。</div>}
        {historyItems.map((it) => {
          const prog = library.lib.watchProgress[`${it.sourceId}:${it.id}`] ?? 0;
          const pct = it.duration ? Math.round((prog / it.duration) * 100) : 0;
          return (
            <div className="track-row" key={it.sourceId + it.id} onDoubleClick={() => onOpen(it)}>
              <span className="tcover" style={{ background: it.cover ? undefined : gradientFor(it.title) }}>
                {it.cover ? <img src={it.cover} alt="" /> : initial(it.title)}
              </span>
              <span className="ttitle" onClick={() => onOpen(it)}>{it.title}</span>
              <span className="tsub">{it.year ?? ''} {it.genre ? '· ' + it.genre : ''}</span>
              <span className="tprog"><span className="tprog-in" style={{ width: pct + '%' }} /></span>
              <span className="tactions">
                <button className="mini" onClick={() => onOpen(it)}><Icon name="play" size={16} /></button>
                <button className="mini" onClick={() => library.toggleFavorite(it)} title="收藏"><Icon name={library.isFavorite(it) ? 'heart-filled' : 'heart'} size={16} /></button>
              </span>
            </div>
          );
        })}
      </div>

      <div className="row-head"><h3>搜索历史</h3></div>
      <div className="track-list video">
        {searchItems.length === 0 && <div className="muted sm">还没有搜索记录。</div>}
        {searchItems.map((kw) => (
          <div className="track-row" key={kw} onClick={() => onSearch?.(kw)}>
            <span className="tcover" style={{ background: 'var(--panel2)' }}><Icon name="search" size={16} /></span>
            <span className="ttitle">{kw}</span>
            <span className="tsub">点击重新搜索</span>
          </div>
        ))}
      </div>
    </div>
  );
}
