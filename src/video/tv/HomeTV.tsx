// TV 首页（清单 §3.2）：左侧竖导航由 TVShell 提供；这里渲染顶部分类长方格 + 卡片走廊。
// 卡片点击 → 按影片名进入搜索结果页（非直接进详情，与影视仓一致）。
import { useEffect, useState } from 'react';
import { fetchHot, type HotData, type HotItem } from '../../lib/hot';
import { TVPoster } from './common';
import { isTvConfirmKey } from '../../lib/focusNav';

const CATS: { key: string; label: string; field?: keyof HotData['categories'] }[] = [
  { key: 'all', label: '推荐' },
  { key: 'tv', label: '电视剧', field: 'tv' },
  { key: 'movie', label: '电影', field: 'movie' },
  { key: 'variety', label: '综艺', field: 'variety' },
  { key: 'anime', label: '动漫', field: 'anime' },
];

export function HomeTV({ onSearch }: { onSearch: (q: string) => void }) {
  const [hot, setHot] = useState<HotData | null>(null);
  const [cat, setCat] = useState('all');

  useEffect(() => {
    let alive = true;
    fetchHot().then((d) => { if (alive && d) setHot(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!hot) {
    return <div className="tv-empty">正在加载推荐内容…</div>;
  }

  // V4.3.9：热榜实际每类 10 部，改为 5 列 × 2 行网格（一屏铺满、对齐不留空）。
  // 导航规则（用户明确要求）：
  //   ←→ 同一行卡片间移动，到最左/最右那张就停住（focusNav 用 data-grid-col 实现封边）；
  //   ↑ 一行行往上（同列），到整页最顶行再↑才到分类标签；分类标签再↑才到顶栏 tab；
  //   ↓ 一行行往下，到整页最底行停住（封底自指）。
  const COLS = 5;
  // V4.4.1：每个分类 10 部（一行 5 个 × 2 行），对齐 UI 定稿「一个标签 10 个卡片」。
  const PER_SECTION = 10;
  // 全局行号：让不同 section 的卡片构成一张连续网格，「上一行」能跨 section 到上一类的卡片。
  let globalRow = 0;
  const row = (title: string, items: HotItem[], sectionIdx: number, totalSections: number) => {
    const slice = items.slice(0, PER_SECTION);
    if (slice.length === 0) return null;
    const rowsInSection = Math.ceil(slice.length / COLS);
    const startRow = globalRow;
    globalRow += rowsInSection;
    const isFirstSection = sectionIdx === 0;
    const isLastSection = sectionIdx === totalSections - 1;
    return (
      <section key={title}>
        <div className="tv-row-title">{title}</div>
        <div className="tv-corridor tv-grid">
          {slice.map((it, i) => {
            const localRow = Math.floor(i / COLS);
            const gRow = startRow + localRow;
            const isTopOfPage = isFirstSection && localRow === 0;
            const isBottomOfPage = isLastSection && localRow === rowsInSection - 1;
            const domId = `tvgrid-${sectionIdx}-${i}`;
            return (
              <TVPoster
                key={it.id}
                name={it.name}
                cover={it.pic}
                type={it.type}
                year={it.year}
                rating={it.rating}
                gridRow={gRow}
                gridCol={i % COLS}
                domId={domId}
                // 整页最顶行↑→分类标签；其余↑靠空间就近回到上一行同列
                navUp={isTopOfPage ? '.tv-cat.active' : undefined}
                // 整页最底行↓→自身（封底，不再往下跳）
                navDown={isBottomOfPage ? `#${domId}` : undefined}
                onClick={() => onSearch(it.name)}
              />
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="tv-home">
      <div className="tv-home-head">
        <div className="tv-home-cats">
          {CATS.map((c) => (
            <div
              key={c.key}
              className={'tv-cat' + (cat === c.key ? ' active' : '')}
              data-focusable=""
              data-nav-up="#tvtab-home"
              data-nav-down=".tv-grid .tv-poster"
              data-ok-handled=""
              onClick={() => setCat(c.key)}
              onKeyDown={(e) => { if (isTvConfirmKey(e)) { e.preventDefault(); e.stopPropagation(); setCat(c.key); } }}
              role="button"
            >
              {c.label}
            </div>
          ))}
        </div>
      </div>

      <div className="tv-home-body" data-scroll>
        {cat === 'all' ? (
          <>
            {row('热门电视剧', hot.categories.tv, 0, 4)}
            {row('热门电影', hot.categories.movie, 1, 4)}
            {row('热门综艺', hot.categories.variety, 2, 4)}
            {row('热门动漫', hot.categories.anime, 3, 4)}
          </>
        ) : (
          row(
            CATS.find((c) => c.key === cat)!.label,
            hot.categories[CATS.find((c) => c.key === cat)!.field!] ?? [],
            0,
            1
          )
        )}
      </div>
    </div>
  );
}
