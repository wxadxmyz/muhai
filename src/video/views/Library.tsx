import { useState } from 'react';
import { useLibrary } from '../../lib/library';
import { MediaItem } from '../../engine/types';
import { gradientFor, initial } from '../../lib/cover';
import { Icon } from '../../components/Icon';

// 影视仓风格：顶部 Tab 切换「观看历史 / 影视收藏」+ 海报卡片网格
export function VideoLibrary({
  library,
  onOpen,
}: {
  library: ReturnType<typeof useLibrary>;
  onOpen: (it: MediaItem) => void;
}) {
  const [tab, setTab] = useState<'history' | 'fav'>('history');

  const historyItems = library.lib.history.filter((i) => i.mediaType === 'video');
  const favItems = library.lib.favorites.filter((i) => i.mediaType === 'video');

  const list = tab === 'history' ? historyItems : favItems;

  return (
    <div className="view library">
      <div className="tabs">
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          观看历史
        </button>
        <button className={tab === 'fav' ? 'active' : ''} onClick={() => setTab('fav')}>
          影视收藏
        </button>
      </div>

      {list.length === 0 ? (
        <div className="empty">
          {tab === 'history' ? '还没有观看记录，去搜部剧看吧～' : '还没有收藏，详情页点 ♡ 即可收藏。'}
        </div>
      ) : (
        <div className="poster-grid">
          {list.map((it) => {
            const key = `${it.sourceId}:${it.id}`;
            const prog = library.lib.watchProgress[key] ?? 0;
            const pct = it.duration ? Math.round((prog / it.duration) * 100) : 0;
            const fav = library.isFavorite(it);
            return (
              <div className="pcard" key={key} onDoubleClick={() => onOpen(it)}>
                <div
                  className="pcover"
                  style={{ background: it.cover ? undefined : gradientFor(it.title) }}
                  onClick={() => onOpen(it)}
                >
                  {it.cover ? <img src={it.cover} alt="" /> : <span className="ph-big">{initial(it.title)}</span>}
                  {it.episodes?.length ? <span className="eps">{it.episodes.length} 集</span> : null}
                  {pct > 0 && (
                    <span className="pbar">
                      <span className="pbar-in" style={{ width: pct + '%' }} />
                    </span>
                  )}
                  <span className="pc-actions">
                    <button className="mini" onClick={(e) => { e.stopPropagation(); onOpen(it); }} title="播放">
                      <Icon name="play" size={16} />
                    </button>
                    <button
                      className="mini"
                      onClick={(e) => { e.stopPropagation(); library.toggleFavorite(it); }}
                      title={fav ? '取消收藏' : '收藏'}
                    >
                      <Icon name={fav ? 'heart-filled' : 'heart'} size={16} />
                    </button>
                  </span>
                </div>
                <div className="ptitle" onClick={() => onOpen(it)}>{it.title}</div>
                <div className="psub">
                  {it.year ?? ''} {it.sourceName ? '· ' + it.sourceName : ''}
                  {pct > 0 ? ` · 看至 ${pct}%` : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
