import { useEffect, useMemo, useState, useRef } from 'react';
import { aggregateSearch, aggregateSuggest, expandSources, MediaItem, MediaType, SourceConfig, SuggestItem } from '../engine';
import { useLibrary } from '../lib/library';
import { downloadStore } from '../lib/downloads';
import { Icon } from './Icon';
import { ProxiedImg } from './ProxiedImg';

type SourceState =
  | { kind: 'ok'; count: number }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

const ALL_KEY = '__all__';

// 联想条目左侧类型徽章配色（影视仓是纯灰文字标签，我们用彩色徽章做差异化，只借"信息布局"这个通用思路）
function badgeCls(t: string): string {
  if (/电影|影|片/.test(t)) return 'b-movie';
  if (/综/.test(t)) return 'b-show';
  if (/动|漫/.test(t)) return 'b-anime';
  if (/音|歌|曲/.test(t)) return 'b-music';
  if (/剧|连续/.test(t)) return 'b-tv';
  return 'b-tv';
}

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

  // V3.3.1 #7：搜索联想
  const [sugg, setSugg] = useState<SuggestItem[]>([]);
  const [suggOpen, setSuggOpen] = useState(false);
  const kwRef = useRef(kw); // 用于丢弃"输入已变"的迟到联想结果
  kwRef.current = kw;
  const suggTimer = useRef<number | null>(null);
  // #8：中文输入法组字中（拼音还没上屏）——此时按搜索键不能拿拼音去搜
  const composingRef = useRef(false);

  // v2.5.1 分级返回：搜索页二级态（正在看某个子站结果）→ 先退回「全部」；
  // 否则放行（由 VideoApp 关闭整个搜索页）。页面钩子约定：false=已拦截逐级退，true=放行。
  const activeSourceRef = useRef(activeSource);
  activeSourceRef.current = activeSource;
  useEffect(() => {
    const prev = (window as any).__onAndroidBack;
    (window as any).__onAndroidBack = () => {
      if (activeSourceRef.current !== ALL_KEY) {
        setActiveSource(ALL_KEY);
        return false; // 已逐级退一层（子站 → 全部）
      }
      // 无内部层级：交还给外层（播放器/VideoApp），不要直接放行系统退出
      return typeof prev === 'function' ? prev() : true;
    };
    return () => {
      (window as any).__onAndroidBack = prev;
    };
  }, []);

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
  // 联想面板：有联想结果且处于"输入态"就整块顶掉下面的历史/结果区
  const panelOpen = suggOpen && sugg.length > 0;

  // V3.3.1 #7：输入防抖 250ms 拉联想。
  // 源没实现 suggest 就返回空数组，联想面板自然不出现，正常搜索不受影响。
  useEffect(() => {
    if (suggTimer.current) window.clearTimeout(suggTimer.current);
    const q = kw.trim();
    // 少于 2 个字不发联想：单字命中太多、价值低，还会白白打一堆请求（#5 反应慢）
    if (q.length < 2) {
      setSugg([]);
      setSuggOpen(false);
      return;
    }
    suggTimer.current = window.setTimeout(async () => {
      try {
        const r = await aggregateSuggest(sources, q, { timeout: 6000 });
        if (kwRef.current !== kw) return; // 期间又输入了新内容 → 丢弃这次结果
        setSugg(r);
        if (r.length) setSuggOpen(true);
      } catch {
        /* 联想失败不影响正常搜索 */
      }
    }, 250);
    return () => {
      if (suggTimer.current) window.clearTimeout(suggTimer.current);
    };
  }, [kw, sources]);

  // 该片上次看到第几集（0-based 集序号，展示时 +1）；undefined = 没看过
  const resumeOf = (s: SuggestItem): number | undefined => {
    if (!s.id || !s.sourceId) return undefined;
    const v = library.lib.resumeEp[`${s.sourceId}:${s.id}`];
    return typeof v === 'number' ? v : undefined;
  };

  // 总集数：从观看历史里取（联想接口不返回总集数，取不到就不画进度环，不编造假比例）
  const totalOf = (s: SuggestItem): number => {
    if (!s.id || !s.sourceId) return 0;
    const key = `${s.sourceId}:${s.id}`;
    const h = library.lib.history.find((x) => `${x.sourceId}:${x.id}` === key);
    return h?.episodes?.length ?? 0;
  };

  // 联想条目 → 可播放的 MediaItem（openDetail 会按 resumeEp 自动续播）
  const toMedia = (s: SuggestItem): MediaItem | null => {
    if (!s.id || !s.sourceId) return null;
    return {
      id: s.id,
      sourceId: s.sourceId,
      sourceName: s.sourceName ?? sources.find((c) => c.id === s.sourceId)?.name ?? '',
      title: s.name,
      cover: s.cover,
      year: s.year,
      mediaType: mediaType ?? 'video',
      episodes: [], // openDetail 会后台拉详情补齐剧集，并按 resumeEp 跳到对应集
    };
  };

  // 关键词高亮：切成 [前, 命中, 后] 三段，避免用 dangerouslySetInnerHTML
  const hl = (text: string) => {
    const q = kw.trim();
    if (!q) return <>{text}</>;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return <>{text}</>;
    return (
      <>
        {text.slice(0, i)}
        <span className="sugg-hl">{text.slice(i, i + q.length)}</span>
        {text.slice(i + q.length)}
      </>
    );
  };

  const suggClick = (s: SuggestItem) => {
    setKw(s.name);
    setSuggOpen(false);
    run(s.name);
  };

  const suggPlay = (s: SuggestItem) => {
    (document.activeElement as HTMLElement | null)?.blur(); // 收起输入法
    const m = toMedia(s);
    if (!m) { suggClick(s); return; } // 联想没带 id（兜底来源）→ 退化成普通搜索
    setSuggOpen(false);
    setSearched(true);
    onPlay(m); // → openDetail：看过就从上次那集续播，没看过就第 1 集
  };

  const run = async (q?: string) => {
    const query = (q ?? kw).trim();
    if (!query) return;
    setKw(query);
    setLoading(true);
    setSearched(true);
    setSuggOpen(false); // #7：开始搜索就收起联想面板
    setActiveSource(ALL_KEY);
    library.addSearch(query);
    // 展开 tvbox 子站（左侧源栏用）
    try {
      const ex = await expandSources(sources);
      setExpanded(ex);
    } catch {
      setExpanded(sources);
    }
    try {
      const r = await aggregateSearch(sources, query, {
        timeout: 10000,
        mediaType,
        // #5：哪个源先回来就把它的结果先显示出来，不再干等最慢的源
        onPartial: (partial) => setItems(partial),
      });
      setItems(r.items);
      setErrors(r.errors);
    } catch (e: any) {
      // v2.5.2 防御：聚合失败不抛未捕获异常（避免搜索页白屏），仅记录错误
      setErrors([{ sourceId: '', sourceName: '', message: e?.message ?? '搜索失败' }]);
      console.log(`[spider] ${query} 搜索失败:`, e?.message ?? e);
    } finally {
      setLoading(false);
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
            V3.3.1 #8：
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
          {kw ? <span className="sclear" onClick={() => { setKw(''); setSuggOpen(false); }}>×</span> : null}
        </div>
        <button className="primary" onClick={() => run()}>搜索</button>
      </div>

      {/* V3.3.1 #7：全屏联想面板。一出现就把「最近搜索 / 结果区」整块顶掉（不是叠加） */}
      {panelOpen ? (
        <div className="sugg-panel" role="listbox" aria-label="搜索联想">
          {sugg.map((s, i) => {
            const ep = resumeOf(s);          // 0-based 集序号；undefined = 没看过
            const total = totalOf(s);        // 观看历史里查到的总集数（0 = 未知 → 不画环）
            const C = 2 * Math.PI * 15.5;
            const ratio = ep !== undefined && total > 0 ? Math.min((ep + 1) / total, 1) : 0;
            return (
              <div
                className="sugg-item"
                key={`${s.sourceId ?? 'x'}:${s.id ?? s.name}:${i}`}
                onClick={() => suggClick(s)}
                role="option"
                aria-selected={false}
              >
                {s.type ? <span className={'sugg-badge ' + badgeCls(s.type)}>{s.type}</span> : null}
                <div className="sugg-main">
                  <div className="sugg-title">{hl(s.name)}</div>
                  <div className="sugg-meta">
                    {s.sourceName ? <span className="sugg-chip">{s.sourceName}</span> : null}
                    {s.year ? <span>{s.year}</span> : null}
                    {ep !== undefined ? (
                      <span className="sugg-resume">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3.2 2" />
                        </svg>
                        看到第 {ep + 1} 集
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  className={'sugg-play' + (ep !== undefined ? ' has-hist' : '')}
                  onClick={(e) => { e.stopPropagation(); suggPlay(s); }}
                  aria-label={ep !== undefined ? `继续播放第 ${ep + 1} 集` : `播放第 1 集`}
                >
                  {ratio > 0 ? (
                    <svg className="sugg-ring" viewBox="0 0 34 34" aria-hidden="true">
                      <circle className="track" cx="17" cy="17" r="15.5" />
                      <circle className="prog" cx="17" cy="17" r="15.5" strokeDasharray={C} strokeDashoffset={C * (1 - ratio)} />
                    </svg>
                  ) : null}
                  <svg className="sugg-tri" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 5v14l11-7z" fill="currentColor" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <>
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
                        {it.cover ? (
                          <ProxiedImg src={it.cover} alt="" fallbackText={it.title} />
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
                        {/* V3.3.0 #3：名字条内嵌封面底部（深色渐变+白字），下方 meta 白区整块移除 */}
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
        </>
      )}
    </div>
  );
}
