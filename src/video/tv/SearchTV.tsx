// TV 搜索页（清单 §3.3）：左侧拼音软键盘（A-Z、0-9 + 搜索/清空/删除/远程搜索），
// 右侧实时模糊联想列表 + 热榜/分类芯片。遥控器方向键移动焦点，OK 输入。
// 输入串既按「拼音首字母」前缀匹配，也兼容中文/数字子串（见 pinyinSearch.ts）。
import { useEffect, useMemo, useState } from 'react';
import { fetchHot, type HotData, type HotItem } from '../../lib/hot';
import { buildPinyinIndex, matchPinyin, type PinyinEntry } from '../../lib/pinyinSearch';
import { useLibrary } from '../../lib/library';

const KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const CHIPS: { key: string; label: string; field?: keyof HotData['categories'] }[] = [
  { key: 'all', label: '热榜' },
  { key: 'tv', label: '电视剧榜', field: 'tv' },
  { key: 'movie', label: '电影榜', field: 'movie' },
  { key: 'variety', label: '综艺榜', field: 'variety' },
  { key: 'anime', label: '动漫榜', field: 'anime' },
];

export function SearchTV({
  onSearch,
  onRemote,
}: {
  onSearch: (q: string) => void;
  onRemote: () => void;
}) {
  const [hot, setHot] = useState<HotData | null>(null);
  const [text, setText] = useState('');
  const [chip, setChip] = useState('all');
  const library = useLibrary('video');

  useEffect(() => {
    let alive = true;
    fetchHot().then((d) => { if (alive && d) setHot(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // 各分类的拼音索引（一次性构建）
  const indexes = useMemo(() => {
    const map: Record<string, PinyinEntry[]> = {};
    const allNames: string[] = [];
    if (hot) {
      (['tv', 'movie', 'variety', 'anime'] as const).forEach((f) => {
        const ns = hot.categories[f].map((x) => x.name);
        map[f] = buildPinyinIndex(ns);
        allNames.push(...ns);
      });
    }
    // 搜索历史也并入「热榜」联想
    allNames.push(...library.lib.searchHistory);
    map['all'] = buildPinyinIndex(allNames);
    return map;
  }, [hot, library.lib.searchHistory]);

  const suggestions: HotItem[] = useMemo(() => {
    if (!hot) return [];
    const idx = indexes[chip] ?? indexes['all'] ?? [];
    const names = matchPinyin(text, idx);
    // 把命中的名字映射回 HotItem（取首条同名的海报/类型/评分），找不到则用纯名构造
    const byName = new Map<string, HotItem>();
    (['tv', 'movie', 'variety', 'anime'] as const).forEach((f) => {
      hot.categories[f].forEach((it) => { if (!byName.has(it.name)) byName.set(it.name, it); });
    });
    return names.slice(0, 30).map((n) => byName.get(n) ?? ({ id: n, name: n } as HotItem));
  }, [text, chip, indexes, hot]);

  const press = (k: string) => {
    if (k === '⌫') setText((t) => t.slice(0, -1));
    else if (k === '清空') setText('');
    else if (k === '搜索') { if (text.trim()) onSearch(text.trim()); }
    else if (k === '远程搜索') onRemote();
    else setText((t) => t + k);
  };

  const keys: string[] = [...KEYS, '清空', '删除', '搜索', '远程搜索'];
  // 36 字母数字进 6×6 网格；4 个功能键单独成行

  return (
    <div className="tv-search">
      <div className="tv-keyboard-wrap">
        <div className="tv-kb-text">
          {text}
          <span className="caret" />
        </div>
        <div className="tv-kb-grid">
          {KEYS.map((k) => (
            <div key={k} className="tv-key" data-focusable="" onClick={() => press(k)} role="button">
              {k}
            </div>
          ))}
        </div>
        <div className="tv-kb-grid" style={{ marginTop: 10 }}>
          <div className="tv-key fn" data-focusable="" onClick={() => press('清空')} role="button">清空</div>
          <div className="tv-key fn danger" data-focusable="" onClick={() => press('删除')} role="button">删除</div>
          <div className="tv-key fn primary" data-focusable="" onClick={() => press('搜索')} role="button">搜索</div>
          <div className="tv-key fn" data-focusable="" onClick={() => press('远程搜索')} role="button">远程搜索</div>
        </div>
      </div>

      <div className="tv-search-right">
        <div className="tv-chips">
          {CHIPS.map((c) => (
            <div
              key={c.key}
              className={'tv-chip' + (chip === c.key ? ' active' : '')}
              data-focusable=""
              onClick={() => setChip(c.key)}
              role="button"
            >
              {c.label}
            </div>
          ))}
        </div>
        <div className="tv-suggest">
          {suggestions.length === 0 ? (
            <div className="tv-empty">{text ? '无匹配，按「搜索」全站查找' : '输入拼音首字母，如 dsj → 电视剧'}</div>
          ) : (
            suggestions.map((it) => (
              <div
                key={it.id}
                className="tv-suggest-item"
                data-focusable=""
                onClick={() => onSearch(it.name)}
                role="button"
              >
                <span>{it.name}</span>
                {it.type ? <span className="sm">{it.year ?? ''}</span> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
