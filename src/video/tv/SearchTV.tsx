// TV 搜索页（清单 §3.3）：左侧拼音软键盘（A-Z、0-9），V4.3.9 起 4 个功能键改为键盘下方 2×2 大按钮；
// 右侧影视仓式「标签墙」：无输入显示热榜词标签、输入首字母显示联想词标签，点标签直接出结果；
// 顶部新增「搜索历史」胶囊行（可单个删除 / 一键清空）。遥控器方向键移动焦点，OK 输入。
// 输入串既按「拼音首字母」前缀匹配，也兼容中文/数字子串（见 pinyinSearch.ts）。
import { useEffect, useMemo, useState } from 'react';
import { fetchHot, type HotData } from '../../lib/hot';
import { buildPinyinIndex, matchPinyin, type PinyinEntry } from '../../lib/pinyinSearch';
import { useLibrary } from '../../lib/library';
import { loadSuggestIndex, subscribeSuggest } from '../../lib/suggestIndex';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
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
  const [suggestVersion, setSuggestVersion] = useState(0);
  const library = useLibrary('video');

  useEffect(() => {
    let alive = true;
    fetchHot().then((d) => { if (alive && d) setHot(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // V4.3.8：订阅「源片名预热索引」，后台预热完成后重算联想。
  useEffect(() => subscribeSuggest(() => setSuggestVersion((v) => v + 1)), []);

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
    allNames.push(...library.lib.searchHistory);
    allNames.push(...loadSuggestIndex().map((e) => e.name));
    map['all'] = buildPinyinIndex(allNames);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hot, library.lib.searchHistory, suggestVersion]);

  // V4.3.9 标签墙词表：有输入 → 拼音首字母联想；无输入 → 当前分类热榜词（影视仓「热门搜索」观感）
  const tags: string[] = useMemo(() => {
    if (!hot) return [];
    if (text.trim()) {
      const idx = indexes[chip] ?? indexes['all'] ?? [];
      return matchPinyin(text, idx).slice(0, 60);
    }
    const f = CHIPS.find((c) => c.key === chip)?.field;
    const ns = f ? hot.categories[f].map((x) => x.name) : [];
    return (ns.length ? ns : [
      ...hot.categories.tv, ...hot.categories.movie, ...hot.categories.variety, ...hot.categories.anime,
    ].map((x) => x.name)).slice(0, 60);
  }, [text, chip, indexes, hot]);

  const press = (k: string) => {
    if (k === '删除') setText((t) => t.slice(0, -1));
    else if (k === '清空') setText('');
    else if (k === '搜索') { if (text.trim()) { library.addSearch(text.trim()); onSearch(text.trim()); } }
    else if (k === '远程搜索') onRemote();
    else setText((t) => t + k);
  };

  // 点标签（联想/热榜/历史）= 按这个词全站搜索（中文，源站可识别）
  const pickTag = (name: string) => {
    library.addSearch(name);
    onSearch(name);
  };

  const searchHistory = library.lib.searchHistory ?? [];

  return (
    <div className="tv-search">
      {/* V4.4.0 #1/#2/#15：左侧键盘栏整体布局——搜索历史框 → 输入框 → 键盘 → 2×2 功能键，
          历史从右栏移到左栏输入框上方；整体上移、功能键完整落屏不再被裁。 */}
      <div className="tv-keyboard-wrap">
        {/* #2：搜索历史移到左侧键盘栏（输入框上方），不再放右侧 */}
        <div className="tv-histbox">
          <div className="tv-histbox-head">
            <span>搜索历史</span>
            {searchHistory.length > 0 && (
              <span className="tv-histbox-clear" data-focusable="" onClick={() => library.clearSearch()} role="button">清空</span>
            )}
          </div>
          <div className="tv-histbox-tags">
            {searchHistory.length === 0 ? (
              <span className="tv-histbox-empty">暂无搜索历史</span>
            ) : searchHistory.slice(0, 10).map((h) => (
              <div key={h} className="tv-histag" data-focusable="" onClick={() => pickTag(h)} role="button">
                <span>{h}</span>
                <span className="tv-tag-x" data-focusable="" onClick={(e) => { e.stopPropagation(); library.removeSearch(h); }} role="button">×</span>
              </div>
            ))}
          </div>
        </div>
        <div className="tv-kb-text">
          {text}
          <span className="caret" />
        </div>
        <div className="tv-kb-grid">
          {LETTERS.map((k) => (
            <div key={k} className="tv-key" data-focusable="" onClick={() => press(k)} role="button">{k}</div>
          ))}
        </div>
        {/* #15：4 个功能键 2×2 大按钮，独立成键盘下方（影视仓式） */}
        <div className="tv-kb-actions">
          <div className="tv-key fn primary" data-focusable="" onClick={() => press('搜索')} role="button">搜索</div>
          <div className="tv-key fn" data-focusable="" onClick={() => press('清空')} role="button">清空</div>
          <div className="tv-key fn" data-focusable="" onClick={() => press('远程搜索')} role="button">远程搜索</div>
          <div className="tv-key fn danger" data-focusable="" onClick={() => press('删除')} role="button">删除</div>
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
        {/* V4.3.9：影视仓式标签墙（无输入=热门搜索，有输入=首字母联想），点标签直接出结果 */}
        <div className="tv-tagwall">
          {tags.length === 0 ? (
            <div className="tv-empty">{text ? '无匹配，按「搜索」全站查找' : '暂无热门搜索'}</div>
          ) : (
            tags.map((name, i) => (
              <div key={`${name}-${i}`} className="tv-wall-tag" data-focusable="" onClick={() => pickTag(name)} role="button">
                {name}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
