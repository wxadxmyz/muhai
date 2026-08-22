import { MediaItem } from '../../engine';
import { aggregateHome, aggregateSearch } from '../../engine';
import { useLibrary } from '../../lib/library';
import { SourceConfig } from '../../engine/types';
import { gradientFor, initial } from '../../lib/cover';
import { Icon } from '../../components/Icon';
import { useEffect, useState } from 'react';

const CATEGORIES = ['电影', '电视剧', '动漫', '综艺', '电影筛选', '电视剧筛选', '动漫筛选'];

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
  // 有源时自动拉取各源首页推荐（添加源后无需手动刷新）
  const [homeItems, setHomeItems] = useState<MediaItem[]>([]);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState('');
  const [activeCat, setActiveCat] = useState<string | null>(null);

  useEffect(() => {
    if (sources.length === 0) {
      setHomeItems([]);
      return;
    }
    let cancelled = false;
    setHomeLoading(true);
    setHomeError('');
    // 选中分类时按关键词取内容（留在首页，不跳搜索页）；
    // 未选时拉取各源首页推荐作为"推荐"流。
    const p = activeCat
      ? aggregateSearch(sources, activeCat.replace('筛选', ''), { timeout: 30000, mediaType: 'video' })
      : aggregateHome(sources, { timeout: 30000 });
    p.then((r) => {
      if (cancelled) return;
      setHomeItems(r.items);
      if (!r.items.length && r.errors.length) {
        setHomeError(r.errors[0]?.message ?? '源暂未返回内容');
      }
    })
      .catch((e) => {
        if (!cancelled) setHomeError(e?.message ?? '加载失败');
      })
      .finally(() => {
        if (!cancelled) setHomeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sources, activeCat]);

  const PosterCard = ({ it }: { it: MediaItem }) => {
    return (
      <div className="pcard" onClick={() => onOpenDetail(it)}>
        <div className="pcover" style={{ background: it.cover ? undefined : gradientFor(it.title) }}>
          {it.cover ? <img src={it.cover} alt="" /> : <span className="ph-big">{initial(it.title)}</span>}
          {it.episodes && it.episodes.length > 1 && <span className="eps">{it.episodes.length}集</span>}
        </div>
        <div className="ptitle">{it.title}</div>
        <div className="psub">{it.year ?? ''} {it.genre ? '· ' + it.genre : ''}</div>
      </div>
    );
  };

  const homeTop = (
    <div className="home-top">
      <div className="ht-logo">幕<span className="dot">海</span></div>
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

      <div className="chips" style={{ display: 'flex', overflowX: 'auto', flexWrap: 'nowrap', gap: 8, paddingBottom: 4 }}>
        {CATEGORIES.map((c) => (
          <button
            key={c}
            className={`chip${activeCat === c ? ' chip-rec' : ''}`}
            style={{ whiteSpace: 'nowrap' }}
            onClick={() => setActiveCat(activeCat === c ? null : c)}
          >
            {c}
          </button>
        ))}
      </div>

      <section className="row-section">
        <div className="row-head">
          <h3>{activeCat ? activeCat : '推荐'}</h3>
          {activeCat && <span className="row-more" onClick={() => setActiveCat(null)}>返回推荐 ›</span>}
        </div>
        {homeLoading ? (
          <div className="empty sm">正在从已添加的来源加载…</div>
        ) : homeItems.length === 0 ? (
          <div className="empty sm">{homeError || '该分类暂无内容，换个关键词或检查源。'}</div>
        ) : (
          <div className="poster-grid">
            {homeItems.map((it) => <PosterCard key={it.sourceId + it.id} it={it} />)}
          </div>
        )}
      </section>
    </div>
  );
}
