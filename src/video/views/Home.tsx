import { useEffect, useState } from 'react';
import { aggregateSearch, MediaItem } from '../../engine';
import { useLibrary } from '../../lib/library';
import { usePlayback } from '../../lib/playback';
import { SourceConfig } from '../../engine/types';
import { gradientFor, initial } from '../../lib/cover';
import { Icon } from '../../components/Icon';

const CATEGORIES = ['推荐', '电影', '剧集', '动漫', '综艺', '纪录片'];

export function Home({
  sources,
  library,
  onOpenDetail,
  onSearch,
  onOpenSources,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  onOpenDetail: (it: MediaItem) => void;
  onSearch: (q: string) => void;
  onOpenSources: () => void;
}) {
  const [all, setAll] = useState<MediaItem[]>([]);

  useEffect(() => {
    if (sources.length === 0) return;
    aggregateSearch(sources, '').then((r) => setAll(r.items.filter((i) => i.mediaType === 'video')));
  }, [sources]);

  const recent = library.lib.history.filter((i) => i.mediaType === 'video');

  const PosterCard = ({ it }: { it: MediaItem }) => {
    const prog = library.lib.watchProgress[`${it.sourceId}:${it.id}`] ?? 0;
    const dur = it.duration || 0;
    const pct = dur ? Math.min(100, Math.round((prog / dur) * 100)) : 0;
    return (
      <div className="pcard" onClick={() => onOpenDetail(it)}>
        <div className="pcover" style={{ background: it.cover ? undefined : gradientFor(it.title) }}>
          {it.cover ? <img src={it.cover} alt="" /> : <span className="ph-big">{initial(it.title)}</span>}
          {it.episodes && it.episodes.length > 1 && <span className="eps">{it.episodes.length}集</span>}
          {pct > 0 && <div className="pbar"><div className="pbar-in" style={{ width: pct + '%' }} /></div>}
        </div>
        <div className="ptitle">{it.title}</div>
        <div className="psub">{it.year ?? ''} {it.genre ? '· ' + it.genre : ''}</div>
      </div>
    );
  };

  const homeTop = (
    <div className="home-top">
      <div className="ht-logo">影<span className="dot">流</span></div>
      <div className="ht-actions">
        <button className="ht-ico" onClick={() => onSearch('')} title="搜索"><Icon name="search" size={22} /></button>
      </div>
    </div>
  );

  if (sources.length === 0) {
    return (
      <div className="view home">
        {homeTop}
        <div className="blank-state">
          <div className="blank-art"><Icon name="film" size={44} /></div>
          <h2>导入 JSON 源，开始看片</h2>
          <p className="muted">在「设置 → 源管理」里导入一个 JSON 源，<br />首页就会列出可看的影视与直播。</p>
          <button className="import-fab" onClick={onOpenSources}>
            <Icon name="plus" size={18} /> 导入 JSON 源
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view home">
      {homeTop}

      <div className="chips">
        {CATEGORIES.map((c) => (
          <button key={c} className={`chip${c === '推荐' ? ' chip-rec' : ''}`} onClick={() => { if (c !== '推荐') onSearch(c); }}>{c}</button>
        ))}
      </div>

      <section className="row-section">
        <div className="row-head"><h3>推荐</h3></div>
        <div className="poster-grid">
          {all.length === 0 && <span className="muted sm">加载中…</span>}
          {all.map((it) => <PosterCard key={it.sourceId + it.id} it={it} />)}
        </div>
      </section>
    </div>
  );
}
