import { useEffect, useState } from 'react';
import { aggregateSearch, MediaItem } from '../../engine';
import { useLibrary } from '../../lib/library';
import { usePlayback } from '../../lib/playback';
import { SourceConfig } from '../../engine/types';
import { gradientFor, initial } from '../../lib/cover';
import { Icon } from '../../components/Icon';

const CATEGORIES = ['电影', '电视剧', '动漫', '综艺', '纪录片', '动画'];

export function Home({
  sources,
  library,
  onOpenDetail,
  onSearch,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  onOpenDetail: (it: MediaItem) => void;
  onSearch: (q: string) => void;
}) {
  const [all, setAll] = useState<MediaItem[]>([]);
  const [q, setQ] = useState('');

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

  if (sources.length === 0) {
    return (
      <div className="view home">
        <div className="search-bar big">
          <span className="search-ico"><Icon name="search" size={18} /></span>
          <input
            value={q}
            placeholder="搜索电影 / 剧集 / 演员…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) onSearch(q.trim()); }}
          />
          <button className="primary" onClick={() => q.trim() && onSearch(q.trim())}>搜索</button>
        </div>
        <div className="blank-state">
          <div className="blank-art"><Icon name="film" size={44} /></div>
          <h2>还没有接入影视源</h2>
          <p className="muted">在「设置 → 源管理」里导入一个 JSON 源，<br />首页就会列出可看的影视与直播。</p>
          <button className="primary" onClick={() => onSearch('')}>去设置添加源</button>
        </div>
      </div>
    );
  }

  return (
    <div className="view home">
      <div className="search-bar big">
        <span className="search-ico"><Icon name="search" size={18} /></span>
        <input
          value={q}
          placeholder="搜索电影 / 剧集 / 演员…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) onSearch(q.trim()); }}
        />
        <button className="primary" onClick={() => q.trim() && onSearch(q.trim())}>搜索</button>
      </div>

      <div className="chips">
        {CATEGORIES.map((c) => (
          <button key={c} className="chip" onClick={() => onSearch(c)}>{c}</button>
        ))}
      </div>

      {recent.length > 0 && (
        <section className="row-section">
          <div className="row-head"><h3>最近在看</h3></div>
          <div className="poster-grid">
            {recent.slice(0, 6).map((it) => <PosterCard key={it.sourceId + it.id} it={it} />)}
          </div>
        </section>
      )}

      <section className="row-section">
        <div className="row-head"><h3>热门影视（跨源聚合）</h3></div>
        <div className="poster-grid">
          {all.length === 0 && <span className="muted sm">加载中…</span>}
          {all.map((it) => <PosterCard key={it.sourceId + it.id} it={it} />)}
        </div>
      </section>
    </div>
  );
}
