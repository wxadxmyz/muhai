// TV 首页（清单 §3.2）：左侧竖导航由 TVShell 提供；这里渲染顶部分类长方格 + 卡片走廊。
// 卡片点击 → 按影片名进入搜索结果页（非直接进详情，与影视仓一致）。
import { useEffect, useState } from 'react';
import { fetchHot, type HotData, type HotItem } from '../../lib/hot';
import { TVPoster } from './common';

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

  const row = (title: string, items: HotItem[]) => (
    <section key={title}>
      <div className="tv-row-title">{title}</div>
      {items.length === 0 ? (
        <div className="tv-empty">暂无内容</div>
      ) : (
        <div className="tv-corridor">
          {items.slice(0, 12).map((it) => (
            <TVPoster
              key={it.id}
              name={it.name}
              cover={it.pic}
              type={it.type}
              year={it.year}
              rating={it.rating}
              onClick={() => onSearch(it.name)}
            />
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="tv-scroll" data-scroll>
      <div className="tv-home-cats">
        {CATS.map((c) => (
          <div
            key={c.key}
            className={'tv-cat' + (cat === c.key ? ' active' : '')}
            data-focusable=""
            onClick={() => setCat(c.key)}
            role="button"
          >
            {c.label}
          </div>
        ))}
      </div>

      {cat === 'all' ? (
        <>
          {row('热门电视剧', hot.categories.tv)}
          {row('热门电影', hot.categories.movie)}
          {row('热门综艺', hot.categories.variety)}
          {row('热门动漫', hot.categories.anime)}
        </>
      ) : (
        row(
          CATS.find((c) => c.key === cat)!.label,
          hot.categories[CATS.find((c) => c.key === cat)!.field!] ?? []
        )
      )}
    </div>
  );
}
