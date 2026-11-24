// TV 搜索结果页（清单 §3.4）：左侧源筛选栏（x/总数 + 各源命中数），右侧结果网格。
// V4.3.9：左侧窄源栏「焦点移上去即切源」（影视仓式，不用按 OK）；右侧固定 5 列网格、卡片固定高度不再被压缩。
// 卡片再点才进详情页。
import { useEffect, useMemo, useRef, useState } from 'react';
import { aggregateSearch, expandSources, MediaItem, SourceConfig } from '../../engine';
import { TVPoster, tvItemPoster } from './common';
import { useLibrary } from '../../lib/library';
import { focusElement } from '../../lib/focusNav';
import { addNamesToSuggestIndex } from '../../lib/suggestIndex';

const ALL_KEY = '__all__';

type SrcState = { kind: 'ok'; count: number } | { kind: 'empty' } | { kind: 'error'; message: string };

export function SearchResultTV({
  query,
  sources,
  onOpenDetail,
  library,
}: {
  query: string;
  sources: SourceConfig[];
  onOpenDetail: (it: MediaItem) => void;
  library: ReturnType<typeof useLibrary>;
}) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [errors, setErrors] = useState<{ sourceId: string; sourceName: string; message: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSource, setActiveSource] = useState<string>(ALL_KEY);
  const [expanded, setExpanded] = useState<SourceConfig[]>([]);
  const seq = useRef(0);
  const allRef = useRef<HTMLDivElement | null>(null);

  // V4.4.0 #8：进入结果页光标直接落「全部」子站
  useEffect(() => {
    const t = window.setTimeout(() => focusElement(allRef.current), 80);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const my = ++seq.current;
    setItems([]);
    setLoading(true);
    setActiveSource(ALL_KEY);
    (async () => {
      let ex: SourceConfig[] = [];
      try { ex = await expandSources(sources); if (my === seq.current) setExpanded(ex); } catch { ex = sources; }
      try {
        const r = await aggregateSearch(ex, query, {
          timeout: 18000,
          onPartial: (p) => { if (my === seq.current) setItems(p); },
        });
        if (my !== seq.current) return;
        setItems(r.items);
        setErrors(r.errors);
        setLoading(false);
        // V4.4.5：搜到的片名增量并入联想索引（搜过一次以后输首字母即可联想，覆盖冷门片）
        addNamesToSuggestIndex(r.items.map((it) => it.title));
      } catch {
        if (my === seq.current) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    expanded.forEach((s) => m.set(s.id, s.name));
    return m;
  }, [expanded]);

  const sourceState = useMemo(() => {
    const map = new Map<string, SrcState>();
    const counts = new Map<string, number>();
    items.forEach((it) => counts.set(it.sourceName, (counts.get(it.sourceName) ?? 0) + 1));
    const errs = new Map<string, string>();
    errors.forEach((e) => { if (!errs.has(e.sourceId)) errs.set(e.sourceId, e.message); });
    expanded.forEach((s) => {
      const pid = (s as any).parentId || s.id;
      if (errs.has(pid)) map.set(s.id, { kind: 'error', message: errs.get(pid)! });
      else if ((counts.get(s.name) ?? 0) > 0) map.set(s.id, { kind: 'ok', count: counts.get(s.name)! });
      else map.set(s.id, { kind: 'empty' });
    });
    return map;
  }, [expanded, items, errors]);

  const visibleItems = useMemo(() => {
    if (activeSource === ALL_KEY) return items;
    const n = nameOf.get(activeSource);
    return n ? items.filter((it) => it.sourceName === n) : items;
  }, [items, activeSource, nameOf]);

  const okSourceCount = useMemo(() => {
    const s = new Set<string>();
    items.forEach((it) => s.add(it.sourceName));
    return s.size;
  }, [items]);

  return (
    <div className="tv-result">
      <div className="tv-result-srcs">
        <div className="src-title">影视源</div>
        <div
          ref={allRef}
          className="tv-result-src active" data-focusable="" data-autofocus=""
          onFocus={() => setActiveSource(ALL_KEY)}
          onClick={() => setActiveSource(ALL_KEY)} role="button"
        >
          <span className="nm" title="全部">全部</span>
          <span className="cnt">{items.length}</span>
        </div>
        {expanded
          .filter((s) => !loading || sourceState.get(s.id)?.kind === 'ok')
          .filter((s) => sourceState.get(s.id)?.kind === 'ok')
          .map((s) => {
            const st = sourceState.get(s.id)!;
            return (
              <div
                key={s.id}
                className={'tv-result-src' + (activeSource === s.id ? ' active' : '')}
                data-focusable=""
                onFocus={() => setActiveSource(s.id)}
                onClick={() => setActiveSource(s.id)}
                role="button"
              >
                <span className="nm" title={s.name}>{s.name}</span>
                <span className="cnt">{st.kind === 'ok' ? st.count : 0}</span>
              </div>
            );
          })}
      </div>

      <div className="tv-result-grid">
        <div className="tv-result-summary">
          {loading ? '跨源搜索中…' : `共 ${visibleItems.length} 部`}
          {activeSource === ALL_KEY && !loading ? ` · 来自 ${okSourceCount} 个源` : ''}
        </div>
        {visibleItems.length === 0 && !loading ? (
          <div className="tv-empty">没有找到结果，换个关键词或检查影视源。</div>
        ) : (
          visibleItems.map((it) => {
            const { cover, name } = tvItemPoster(it);
            return (
              <TVPoster
                key={it.sourceId + it.id}
                name={name}
                cover={cover}
                year={it.year}
                rating={it.score ? Number(it.score) : undefined}
                onClick={() => onOpenDetail(it)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
