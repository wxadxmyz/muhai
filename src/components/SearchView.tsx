import { useEffect, useMemo, useRef, useState } from 'react';
import { aggregateSearch, MediaItem, MediaType, SourceConfig } from '../engine';
import { useLibrary } from '../lib/library';
import { downloadStore } from '../lib/downloads';
import { Icon } from './Icon';

type SourceState =
  | { kind: 'ok'; count: number }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

const ALL_KEY = '__all__';

function sourceKey(src: SourceConfig): string {
  return src.id || src.name;
}

function buildSourceState(
  sources: SourceConfig[],
  items: MediaItem[],
  errors: { sourceId: string; sourceName: string; message: string }[],
): Map<string, SourceState> {
  const map = new Map<string, SourceState>();
  // 计数
  const counts = new Map<string, number>();
  for (const it of items) {
    counts.set(it.sourceId, (counts.get(it.sourceId) ?? 0) + 1);
  }
  // 错误
  const errs = new Map<string, string>();
  for (const e of errors) {
    const key = e.sourceId || e.sourceName;
    if (!errs.has(key)) errs.set(key, e.message);
  }
  for (const src of sources) {
    const k = sourceKey(src);
    if (errs.has(k)) map.set(k, { kind: 'error', message: errs.get(k)! });
    else if ((counts.get(k) ?? 0) > 0) map.set(k, { kind: 'ok', count: counts.get(k)! });
    else map.set(k, { kind: 'empty' });
  }
  return map;
}

export function SearchView({
  sources,
  onPlay,
  onQueue,
  library,
  mediaType,
  placeholder = '搜索…',
  enableQueue = true,
  initialQuery,
  onClose,
}: {
  sources: SourceConfig[];
  onPlay: (item: MediaItem) => void;
  onQueue?: (items: MediaItem[]) => void;
  library: ReturnType<typeof useLibrary>;
  mediaType?: MediaType;
  placeholder?: string;
  enableQueue?: boolean;
  initialQuery?: string;
  onClose?: () => void;
}) {
  const [kw, setKw] = useState(initialQuery ?? '');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [errors, setErrors] = useState<{ sourceId: string; sourceName: string; message: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [activeSource, setActiveSource] = useState<string>(ALL_KEY);
  const [toastOn, setToastOn] = useState(true);
  const toastTimer = useRef<number | null>(null);

  const sourceState = useMemo(
    () => buildSourceState(sources, items, errors),
    [sources, items, errors],
  );

  const showHints = !searched && kw.trim() === '';

  // 每次搜索后展示一次提示条，3.5s 自动消失
  const flashToast = () => {
    setToastOn(true);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastOn(false), 3500);
  };
  useEffect(() => {
    if (searched) flashToast();
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched]);

  const run = async (q?: string) => {
    const query = (q ?? kw).trim();
    if (!query) return;
    setKw(query);
    setLoading(true);
    setSearched(true);
    setActiveSource(ALL_KEY);
    library.addSearch(query);
    const r = await aggregateSearch(sources, query, { timeout: 30000, mediaType });
    setItems(r.items);
    setErrors(r.errors);
    setLoading(false);
  };

  // 按当前源过滤
  const visibleItems = useMemo(() => {
    if (activeSource === ALL_KEY) return items;
    return items.filter((it) => sourceKey({ id: it.sourceId, name: it.sourceName } as SourceConfig) === activeSource);
  }, [items, activeSource]);

  // 全部源的总结果数（不受 activeSource 影响，用于侧栏"全部"徽标）
  const totalCount = items.length;
  const okSourceCount = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) s.add(it.sourceId);
    return s.size;
  }, [items]);

  useEffect(() => {
    if (initialQuery && initialQuery.trim()) run(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="view searchview">
      <div className="searchtop">
        {onClose && (
          <button className="icon sback" onClick={onClose} aria-label="返回">
            <Icon name="arrow-left" size={22} />
          </button>
        )}
        <div className="sinput">
          <span className="search-ico"><Icon name="search" size={18} /></span>
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder={placeholder}
          />
          {kw ? <span className="sclear" onClick={() => setKw('')}>×</span> : null}
        </div>
        <button className="primary" onClick={() => run()}>搜索</button>
      </div>

      <div className={'search-toast' + (toastOn ? ' show' : '')}>
        <span className="search-toast-icon">⚠</span>
        <span className="search-toast-text">
          内容来自第三方公开接口，仅供本地检索与学习使用，请遵守当地法律法规。
        </span>
        <span className="search-toast-close" onClick={() => setToastOn(false)} aria-label="关闭">×</span>
      </div>

      {!showHints && (
        <div className="search-count">
          <span>
            共 <b>{visibleItems.length}</b> 部
            {activeSource === ALL_KEY ? <> · 来自 <b>{okSourceCount}</b> 个源</> : null}
          </span>
          {loading && <span className="search-count-tip">跨源搜索中…</span>}
        </div>
      )}

      {showHints ? (
        library.lib.searchHistory.length > 0 ? (
          <div className="search-history">
            <div className="sh-head">
              <span>搜索历史</span>
              <button className="link" onClick={() => library.clearSearch()}>清空</button>
            </div>
            <div className="bubbles">
              {library.lib.searchHistory.map((h) => (
                <span key={h} className="bub" onClick={() => run(h)}>
                  {h}
                  <span className="bub-x" onClick={(e) => { e.stopPropagation(); library.removeSearch(h); }}>
                    <Icon name="x" size={12} />
                  </span>
                </span>
              ))}
            </div>
          </div>
        ) : null
      ) : (
        <div className="search-body">
          <aside className="search-sources" aria-label="视频源">
            <div
              className={'search-source' + (activeSource === ALL_KEY ? ' active' : '')}
              onClick={() => setActiveSource(ALL_KEY)}
              role="button"
            >
              <div className="search-source-badge all">全</div>
              <span className="search-source-name">全部</span>
              <span className="search-source-count">{totalCount}</span>
            </div>
            {sources.map((src) => {
              const st = sourceState.get(sourceKey(src));
              const isError = st?.kind === 'error';
              const isActive = activeSource === sourceKey(src);
              return (
                <div
                  key={sourceKey(src)}
                  className={
                    'search-source' +
                    (isActive ? ' active' : '') +
                    (isError ? ' error' : '')
                  }
                  onClick={() => !isError && setActiveSource(sourceKey(src))}
                  role="button"
                  title={isError ? `该源未连通：${st?.kind === 'error' ? st.message : ''}` : src.name}
                >
                  <div className="search-source-badge">{src.name.slice(0, 1)}</div>
                  <span className="search-source-name">{src.name}</span>
                  {isError ? (
                    <span className="search-source-warn" aria-label="未连通">!</span>
                  ) : (
                    <span className="search-source-count">{st?.kind === 'ok' ? st.count : 0}</span>
                  )}
                </div>
              );
            })}
          </aside>

          <main className="search-grid-wrap">
            {activeSource !== ALL_KEY &&
              sourceState.get(activeSource)?.kind === 'error' && (
                <div className="search-grid-error">
                  <div className="search-grid-error-title">该源未连通</div>
                  <div className="search-grid-error-msg">
                    {sourceState.get(activeSource)?.kind === 'error'
                      ? (sourceState.get(activeSource) as { kind: 'error'; message: string }).message
                      : ''}
                  </div>
                </div>
              )}

            {(activeSource === ALL_KEY || sourceState.get(activeSource)?.kind !== 'error') &&
              (visibleItems.length > 0 ? (
                <div className="search-grid">
                  {visibleItems.map((it) => (
                    <div
                      className="search-card"
                      key={it.sourceId + it.id}
                      onClick={() => onPlay(it)}
                    >
                      <div className="search-poster">
                        {it.cover ? (
                          <img src={it.cover} alt="" loading="lazy" />
                        ) : (
                          <div className="search-poster-fallback">
                            <Icon name={it.mediaType === 'music' ? 'music' : 'film'} size={32} />
                          </div>
                        )}
                        <span className="search-poster-src" title={it.sourceName}>
                          {it.sourceName.slice(0, 2)}
                        </span>
                        {it.episodes && it.episodes.length > 0 && (
                          <span className="search-poster-eps">
                            {it.episodes.length > 1 ? `更新至 ${it.episodes.length} 集` : it.episodes[0].name || '全集'}
                          </span>
                        )}
                      </div>
                      <div className="search-card-meta">
                        <div className="search-card-title">{it.title}</div>
                        <div className="search-card-sub">
                          {it.year ?? (it.episodes && it.episodes.length > 1 ? `${it.episodes.length} 集` : '')}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                !loading && searched && (
                  <div className="empty">
                    {activeSource === ALL_KEY
                      ? '没有找到结果，换个关键词或检查音源。'
                      : '该源暂无相关内容。'}
                  </div>
                )
              ))}
          </main>
        </div>
      )}
    </div>
  );
}
