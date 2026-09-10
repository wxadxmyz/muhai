import { useLibrary } from '../lib/library';
import { MediaItem } from '../engine/types';
import { gradientFor, initial } from '../lib/cover';
import { Icon } from '../components/Icon';
import { ProxiedImg } from '../components/ProxiedImg';

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
  // V3.3.2 #3：详情字段可能来自「半残」源（详情接口只回 title，封面/年份/类型/简介全空）。
  // 这里做强兜底——绝不渲染出整片空白：封面走 ProxiedImg 的片名兜底，
  // 文本字段缺失时不显示空标签，只给友好的「该源暂无…」提示。
  const desc: string = detail.desc || detail.raw?.desc || detail.raw?.vod_content || detail.raw?.vod_blurb || '';
  const hasAnyMeta = !!(detail.cover || detail.year || detail.genre || desc || (detail.episodes && detail.episodes.length));

  return (
    <div className="view detail-view">
      <button className="link" onClick={onBack}><Icon name="arrow-left" size={16} /> 返回</button>
      <div className="detail-grid">
        <div className="detail-poster" style={{ background: detail.cover ? undefined : gradientFor(detail.title) }}>
          {detail.cover ? <ProxiedImg src={detail.cover} alt="" fallbackText={detail.title} /> : <span className="ph-big">{initial(detail.title)}</span>}
        </div>
        <div className="detail-info">
          <h1>{detail.title || '未命名'}</h1>
          <div className="detail-meta">
            {detail.year ? <span>{detail.year}</span> : null}
            {detail.genre && <span className="badge">{detail.genre}</span>}
            <span>{detail.episodes?.length ? detail.episodes.length + ' 集' : '单集'}</span>
            <span className="src-tag">源：{detail.sourceName}</span>
          </div>
          <p className="detail-desc">{desc || '该源暂无剧情简介。'}</p>
          {!hasAnyMeta && (
            <p className="detail-note">该源返回的详情信息较少，仍可正常播放；如有问题可换其它源。</p>
          )}
          <div className="detail-actions">
            <button className="primary" onClick={() => onSelectEpisode(0)}><Icon name="play" size={16} /> 立即播放</button>
            <button className={fav ? 'fav' : ''} onClick={() => library.toggleFavorite(detail)}>
              <Icon name={fav ? 'heart-filled' : 'heart'} size={16} /> {fav ? '已收藏' : '收藏'}
            </button>
          </div>
        </div>
      </div>

      {detail.episodes && detail.episodes.length > 0 ? (
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
      ) : (
        <div className="detail-episodes">
          <h3>选集 / 线路</h3>
          <p className="detail-note">该源未提供选集列表，点击「立即播放」将直接播放第一集。</p>
        </div>
      )}
    </div>
  );
}
