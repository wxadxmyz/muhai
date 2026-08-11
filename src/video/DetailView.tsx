import { useLibrary } from '../lib/library';
import { MediaItem } from '../engine/types';
import { gradientFor, initial } from '../lib/cover';
import { Icon } from '../components/Icon';

export function DetailView({
  detail,
  episodeIndex,
  onSelectEpisode,
  onBack,
}: {
  detail: MediaItem;
  episodeIndex: number;
  onSelectEpisode: (i: number) => void;
  onBack: () => void;
}) {
  const library = useLibrary('video');
  const fav = library.isFavorite(detail);
  const desc: string = detail.raw?.desc ?? '接入真实影视源后展示剧情简介。';

  return (
    <div className="view detail-view">
      <button className="link" onClick={onBack}><Icon name="arrow-left" size={16} /> 返回</button>
      <div className="detail-grid">
        <div className="detail-poster" style={{ background: detail.cover ? undefined : gradientFor(detail.title) }}>
          {detail.cover ? <img src={detail.cover} alt="" /> : <span className="ph-big">{initial(detail.title)}</span>}
        </div>
        <div className="detail-info">
          <h1>{detail.title}</h1>
          <div className="detail-meta">
            <span>{detail.year}</span>
            {detail.genre && <span className="badge">{detail.genre}</span>}
            <span>{detail.episodes?.length ? detail.episodes.length + ' 集' : '单集'}</span>
            <span className="src-tag">源：{detail.sourceName}</span>
          </div>
          <p className="detail-desc">{desc}</p>
          <div className="detail-actions">
            <button className="primary" onClick={() => onSelectEpisode(0)}><Icon name="play" size={16} /> 立即播放</button>
            <button className={fav ? 'fav' : ''} onClick={() => library.toggleFavorite(detail)}>
              <Icon name={fav ? 'heart-filled' : 'heart'} size={16} /> {fav ? '已收藏' : '收藏'}
            </button>
          </div>
        </div>
      </div>

      {detail.episodes && detail.episodes.length > 0 && (
        <div className="detail-episodes">
          <h3>选集 / 线路</h3>
          <div className="ep-grid">
            {detail.episodes.map((ep, i) => (
              <button key={i} className={'ep-btn' + (i === episodeIndex ? ' active' : '')} onClick={() => onSelectEpisode(i)}>
                {ep.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
