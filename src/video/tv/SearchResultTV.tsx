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

  // V4.5.8 #2：落焦「全部」改到数据全部到位后（loading 由 true→false）再执行。
  // 旧版挂载后固定 80ms 就落焦，而结果是通过 onPartial 分批塞入、网格多次重排，
  // 叠加 .tv-result 四边负 margin 容器的 scrollIntoView，用户看到卡片"一秒后往左跑一点"。
  // 现在加载期不渲染卡片、完整结果一次性到位再落焦，杜绝首屏跳动。
  useEffect(() => {
    if (loading) return;
    const t = window.setTimeout(() => focusElement(allRef.current), 40);
    return () => window.clearTimeout(t);
  }, [loading]);

  useEffect(() => {
    const my = ++seq.current;
    setItems([]);
    setLoading(true);
    setActiveSource(ALL_KEY);
    (async () => {
      let ex: SourceConfig[] = [];
      try { ex = await expandSources(sources); if (my === seq.current) setExpanded(ex); } catch { ex = sources; }
      try {
        // V4.5.10 #11：恢复 onPartial 分批显示——哪个子站先加载先显示，不再白屏等全部源。
        // 关键：分批期间不落焦（落焦统一延到 loading 完成后的 effect，见上），
        // 且只 setItems 不触发横向滚动，避免「卡片一秒后往左跑」。
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
      {/* V4.5.2 #2：统计条提到结果页顶层、左对齐与源栏同起点（原来在 grid 内偏右） */}
      <div className="tv-result-summary">
        {loading ? '跨源搜索中…' : `共 ${visibleItems.length} 部`}
        {activeSource === ALL_KEY && !loading ? ` · 来自 ${okSourceCount} 个源` : ''}
      </div>
      <div className="tv-result-srcs">
        <div
          ref={allRef}
          className="tv-result-src active" data-focusable="" data-autofocus="" data-src-pill=""
          onFocus={() => setActiveSource(ALL_KEY)}
          onClick={() => setActiveSource(ALL_KEY)} role="button"
        >
          <span className="nm" title="全部">全部</span>
        </div>
        {expanded
          .filter((s) => !loading || sourceState.get(s.id)?.kind === 'ok')
          .filter((s) => sourceState.get(s.id)?.kind === 'ok')
          .map((s) => {
            return (
              <div
                key={s.id}
                className={'tv-result-src' + (activeSource === s.id ? ' active' : '')}
                data-focusable="" data-src-pill=""
                onFocus={() => setActiveSource(s.id)}
                onClick={() => setActiveSource(s.id)}
                role="button"
              >
                <span className="nm" title={s.name}>{s.name}</span>
              </div>
            );
          })}
      </div>

      <div className="tv-result-grid">
        {visibleItems.length === 0 && !loading ? (
          <div className="tv-empty">没有找到结果，换个关键词或检查影视源。</div>
        ) : (
          visibleItems.map((it, idx) => {
            const { cover, name } = tvItemPoster(it);
            return (
              <TVPoster
                key={it.sourceId + it.id}
                name={name}
                cover={cover}
                year={it.year}
                rating={it.score ? Number(it.score) : undefined}
                // V4.5.10 #13/#14：给结果卡片补网格坐标，左右键按列逐张移动、上下键同列逐行移动。
                gridCol={idx % 5}
                gridRow={Math.floor(idx / 5)}
                onClick={() => onOpenDetail(it)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
