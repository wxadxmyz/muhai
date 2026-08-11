import { useEffect, useState } from 'react';
import { aggregateSearch, MediaItem, MediaType, SourceConfig } from '../engine';
import { useLibrary } from '../lib/library';
import { downloadStore } from '../lib/downloads';
import { Icon } from './Icon';

export function SearchView({
  sources,
  onPlay,
  onQueue,
  library,
  mediaType,
  placeholder = '搜索…',
  enableQueue = true,
  initialQuery,
}: {
  sources: SourceConfig[];
  onPlay: (item: MediaItem) => void;
  onQueue?: (items: MediaItem[]) => void;
  library: ReturnType<typeof useLibrary>;
  mediaType?: MediaType;
  placeholder?: string;
  enableQueue?: boolean;
  initialQuery?: string;
}) {
  const [kw, setKw] = useState(initialQuery ?? '');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [errors, setErrors] = useState<{ sourceId: string; message: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const run = async (q?: string) => {
    const query = (q ?? kw).trim();
    if (!query) return;
    setKw(query);
    setLoading(true);
    setSearched(true);
    library.addSearch(query);
    const r = await aggregateSearch(sources, query, { timeout: 8000, mediaType });
    setItems(r.items);
    setErrors(r.errors);
    setLoading(false);
  };

  const groups = items.reduce<Record<string, MediaItem[]>>((acc, it) => {
    (acc[it.sourceName] ??= []).push(it);
    return acc;
  }, {});

  useEffect(() => {
    if (initialQuery && initialQuery.trim()) run(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="view">
      <div className="search-bar big">
        <span className="search-ico"><Icon name="search" size={18} /></span>
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder={placeholder}
        />
        <button className="primary" onClick={() => run()}>搜索</button>
      </div>

      {library.lib.searchHistory.length > 0 && !searched && (
        <div className="search-history">
          <div className="sh-head">
            <span>搜索历史</span>
            <button className="link" onClick={() => library.clearSearch()}>清空</button>
          </div>
          <div className="chips">
            {library.lib.searchHistory.map((h) => (
              <button key={h} className="chip" onClick={() => run(h)}>{h}</button>
            ))}
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <div className="err">部分源失败：{errors.map((e) => e.sourceId).join('、')}（可在调试面板查看详情）</div>
      )}

      {loading && <div className="loading">跨源搜索中…</div>}

      {Object.entries(groups).map(([src, list]) => (
        <div key={src} className="result-group">
          <div className="row-head">
            <h4>来自：{src}（{list.length}）</h4>
            {enableQueue && onQueue && (
              <button className="link" onClick={() => onQueue(list)}>整组加入队列</button>
            )}
          </div>
          <div className={mediaType === 'video' ? 'cards video-cards' : 'cards'}>
            {list.map((it) => (
              <div className={mediaType === 'video' ? 'vcard' : 'card'} key={it.sourceId + it.id} onClick={() => onPlay(it)}>
                <div className={mediaType === 'video' ? 'vcover' : 'cover'}>
                  {it.cover ? <img src={it.cover} alt="" /> : <Icon name={it.mediaType === 'music' ? 'music' : 'film'} size={mediaType === 'video' ? 40 : 22} />}
                </div>
                <div className="meta">
                  <div className="title">{it.title}</div>
                  <div className="sub">{it.artist ?? it.year ?? ''}{it.artist && it.year ? ' · ' + it.year : ''}</div>
                  <div className="src-tag">{it.sourceName}</div>
                </div>
                {it.episodes && it.episodes.length > 1 && <span className="eps">{it.episodes.length}集</span>}
                <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="mini" title="播放" onClick={() => onPlay(it)}><Icon name="play" size={16} /></button>
                  {enableQueue && onQueue && (
                    <button className="mini" title="加入队列" onClick={() => onQueue([it])}><Icon name="plus" size={16} /></button>
                  )}
                  <button
                    className={'mini' + (library.isFavorite(it) ? ' fav' : '')}
                    title="收藏"
                    onClick={() => library.toggleFavorite(it)}
                  >
                    <Icon name={library.isFavorite(it) ? 'heart-filled' : 'heart'} size={16} />
                  </button>
                  <button className="mini" title="下载" onClick={() => downloadStore.start(it)}><Icon name="download" size={16} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {searched && !loading && items.length === 0 && <div className="empty">没有找到结果，换个关键词或检查音源。</div>}
    </div>
  );
}
