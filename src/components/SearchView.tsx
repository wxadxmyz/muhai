import { useEffect, useMemo, useState, useRef } from 'react';
import { aggregateSearch, expandSources, MediaItem, MediaType, SourceConfig } from '../engine';
import { useLibrary } from '../lib/library';
import { downloadStore } from '../lib/downloads';
import { Icon } from './Icon';
import { ProxiedImg } from './ProxiedImg';
import { tryCoverFallback } from '../lib/crossCover';
import { pushBackHandler } from '../lib/backStack';

type SourceState =
  | { kind: 'ok'; count: number }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

const ALL_KEY = '__all__';

function parentIdOf(src: SourceConfig): string {
  return ((src as any).parentId as string) || src.id;
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
  const [expanded, setExpanded] = useState<SourceConfig[]>([]);
  // V3.3.8 Bug 3/4：主源封面加载失败时，回退到豆瓣同名封面 / 其它源同名封面（按 key 局部回填）
  const [cross, setCross] = useState<Record<string, string>>({});

  // #8：中文输入法组字中（拼音还没上屏）——此时按搜索键不能拿拼音去搜
  const composingRef = useRef(false);

  // V3.3.4：搜索竞态守卫——连续两次搜索时（历史联想、快速改词），上一个慢源的结果晚到
  // 会把新结果整体覆盖、或把 loading 态错关。每次 run 自增序号，所有异步回调只认最新一次。
  const searchSeqRef = useRef(0);

  // v2.5.1 分级返回：搜索页二级态（正在看某个子站结果）→ 先退回「全部」；
  // 否则放行（返回 false，由栈下一层/VideoApp 外层关闭整个搜索页）。
  // V3.3.5 B2：不再 prev 链式覆盖 __onAndroidBack，改压返回栈。
  const activeSourceRef = useRef(activeSource);
  activeSourceRef.current = activeSource;
  useEffect(
    () =>
      pushBackHandler(() => {
        if (activeSourceRef.current !== ALL_KEY) {
          setActiveSource(ALL_KEY);
          return true; // 已逐级退一层（子站 → 全部）
        }
        return false; // 无内部层级：交还栈下一层
      }),
    []
  );

  // 子站 id <-> name 映射（供过滤）
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of expanded) m.set(s.id, s.name);
    return m;
  }, [expanded]);

  const sourceState = useMemo(() => {
    const map = new Map<string, SourceState>();
    // 计数：items 的 sourceName 即子站名
    const counts = new Map<string, number>();
    for (const it of items) {
      counts.set(it.sourceName, (counts.get(it.sourceName) ?? 0) + 1);
    }
    // 错误：按配置 id（parentId）归类到其下所有子站
    const errs = new Map<string, string>();
    for (const e of errors) {
      if (!errs.has(e.sourceId)) errs.set(e.sourceId, e.message);
    }
    for (const s of expanded) {
      const pid = parentIdOf(s);
      if (errs.has(pid)) map.set(s.id, { kind: 'error', message: errs.get(pid)! });
      else if ((counts.get(s.name) ?? 0) > 0) map.set(s.id, { kind: 'ok', count: counts.get(s.name)! });
      else map.set(s.id, { kind: 'empty' });
    }
    return map;
  }, [expanded, items, errors]);

  const showHints = !searched && kw.trim() === '';

  const run = async (q?: string) => {
    const query = (q ?? kw).trim();
    if (!query) return;
    const mySeq = ++searchSeqRef.current; // V3.3.4：本次搜索的代际序号
    setKw(query);
    setLoading(true);
    setSearched(true);
    setActiveSource(ALL_KEY);
    library.addSearch(query);
    // 展开 tvbox 子站（左侧源栏用）
    try {
      const ex = await expandSources(sources);
      if (mySeq === searchSeqRef.current) setExpanded(ex);
    } catch {
      setExpanded(sources);
    }
    try {
      const r = await aggregateSearch(sources, query, {
        timeout: 10000,
        mediaType,
        // #5：哪个源先回来就把它的结果先显示出来，不再干等最慢的源
        // V3.3.4：过期搜索的增量回调直接丢弃，不再覆盖最新结果
        onPartial: (partial) => { if (mySeq === searchSeqRef.current) setItems(partial); },
      });
      if (mySeq !== searchSeqRef.current) return; // 已被更新的搜索取代：整体丢弃过期结果
      setItems(r.items);
      setErrors(r.errors);
    } catch (e: any) {
      if (mySeq !== searchSeqRef.current) return;
      // v2.5.2 防御：聚合失败不抛未捕获异常（避免搜索页白屏），仅记录错误
      setErrors([{ sourceId: '', sourceName: '', message: e?.message ?? '搜索失败' }]);
      console.log(`[spider] ${query} 搜索失败:`, e?.message ?? e);
    } finally {
      // V3.3.4：只有最新一次搜索才能关 loading，防止旧搜索把新搜索的加载态错关
      if (mySeq === searchSeqRef.current) setLoading(false);
    }
  };

  // 按当前源过滤（子站用 name 匹配，items 的 sourceName 即子站名）
  const visibleItems = useMemo(() => {
    if (activeSource === ALL_KEY) return items;
    const n = nameOf.get(activeSource);
    if (!n) return items;
    return items.filter((it) => it.sourceName === n);
  }, [items, activeSource, nameOf]);

  const totalCount = items.length;
  const okSourceCount = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) s.add(it.sourceName);
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
          {/*
            #8：
            - type="search" + enterKeyHint="search" → 安卓/鸿蒙输入法右下角显示「搜索」键（不是换行）
            - 回车时先 blur() 主动收起软键盘，再执行搜索（旧版键盘不消失）
            - compositionstart/end：中文拼音还没上屏（组字中）时按搜索键不触发，
              避免拿 "zhongguo" 这种拼音去搜（旧版会搜出一堆空结果）
          */}
          <input
            type="search"
            enterKeyHint="search"
            inputMode="search"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && (e as any).keyCode !== 66) return;
              if (composingRef.current) return; // 拼音组字中：放行给输入法上屏，不搜索
              e.preventDefault();
              (e.target as HTMLInputElement).blur(); // 收起软键盘
              run();
            }}
            placeholder={placeholder}
          />
          {kw ? <span className="sclear" onClick={() => setKw('')}>×</span> : null}
        </div>
        <button className="primary" onClick={() => run()}>搜索</button>
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
                <span className="search-source-name">全部</span>
                <span className="search-source-count">{totalCount}</span>
              </div>
            {expanded.map((src) => {
              const st = sourceState.get(src.id);
              const isError = st?.kind === 'error';
              const isActive = activeSource === src.id;
              return (
                <div
                  key={src.id}
                  className={
                    'search-source' +
                    (isActive ? ' active' : '') +
                    (isError ? ' error' : '')
                  }
                  onClick={() => !isError && setActiveSource(src.id)}
                  role="button"
                  title={isError ? `该源未连通：${st?.kind === 'error' ? st.message : ''}` : src.name}
                >
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
            {/* Q21：部分源（如索尼）搜索接口返回非 JSON 错误页，给出友好提示而非崩溃 */}
            {errors.some((e) => /非 JSON|接口返回|HTML|解析/.test(e.message)) && visibleItems.length === 0 && (
              <div className="search-grid-error">
                <div className="search-grid-error-title">部分源暂不支持搜索</div>
                <div className="search-grid-error-msg">
                  有源返回了非标准数据（可能是该源搜索接口暂不可用）。可换其他源，或在浏览器打开该源站点搜索后回 App 播放。
                </div>
              </div>
            )}
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
                        {/* V3.3.1 Q2：补 fallbackText——封面取不到时显示片名文字卡，
                            不再是一块看不出所以然的空白渐变 */}
                        {(() => {
                          const key = it.sourceId + it.id;
                          const show = cross[key] ?? it.cover;
                          if (!show) return (
                            <div className="search-poster-fallback">
                              <Icon name={it.mediaType === 'music' ? 'music' : 'film'} size={32} />
                            </div>
                          );
                          return (
                            <ProxiedImg
                              key={cross[key] ? 'x' + key : key}
                              src={show}
                              alt=""
                              fallbackText={it.title}
                              onFinalFail={() =>
                                tryCoverFallback({
                                  key,
                                  title: it.title,
                                  allSources: sources,
                                  onResolved: (u) => setCross((s) => ({ ...s, [key]: u })),
                                })
                              }
                            />
                          );
                        })()}
                        <span className="search-poster-src" title={it.sourceName}>
                          {it.sourceName.slice(0, 2)}
                        </span>
                        {it.episodes && it.episodes.length > 0 && (
                          <span className="search-poster-eps">
                            {it.episodes.length > 1 ? `更新至 ${it.episodes.length} 集` : it.episodes[0].name || '全集'}
                          </span>
                        )}
                        {/* 名字条内嵌封面底部（深色渐变+白字） */}
                        <div className="cover-name">{it.title}</div>
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
