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
  library,
}: {
  onSearch: (q: string, from?: 'home-card' | 'search') => void;
  onRemote: () => void;
  library: ReturnType<typeof useLibrary>;
}) {
  const [hot, setHot] = useState<HotData | null>(null);
  const [text, setText] = useState('');
  const [chip, setChip] = useState('all');
  const [suggestVersion, setSuggestVersion] = useState(0);
  // V4.4.2 #7：改用 TVShell 传入的同一份 library 实例。旧版这里自己 useLibrary('video')，
  // 与外壳那份是两份独立 state、都写同一个 localStorage key，搜索历史写入后可能被另一份的 effect 覆盖，
  // 导致从结果页返回后历史丢失。统一成一份 state 后写入即持久、返回可读。

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
      const hits = matchPinyin(text, idx);
      // V4.4.3 #12：有输入但一个都没匹配到时，回退显示热榜词，保证右侧联想墙始终有小标签
      if (hits.length) return hits.slice(0, 60);
      const f0 = CHIPS.find((c) => c.key === chip)?.field;
      const fallback = f0 ? hot.categories[f0].map((x) => x.name) : [];
      return (fallback.length ? fallback : [...hot.categories.tv, ...hot.categories.movie].map((x) => x.name)).slice(0, 30);
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
      {/* V4.4.3 #11：搜索历史独立成最左列（设计稿三列：历史列 / 键盘列 / 联想墙），
          不再压在键盘上方。仅在「进过结果页产生历史」后显示；清空后为空自动隐藏。 */}
      {searchHistory.length > 0 && (
        <div className="tv-histcol">
          <div className="tv-histbox-head">
            <span>搜索历史</span>
            <span className="tv-histbox-clear" data-focusable="" onClick={() => library.clearSearch()} role="button">清空</span>
          </div>
          <div className="tv-histwrap">
            {searchHistory.slice(0, 10).map((h) => (
              <div key={h} className="tv-histag" data-focusable="" onClick={() => pickTag(h)} role="button">
                <span>{h}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* 中间键盘列：输入框 → 键盘 → 2×2 功能键 */}
      <div className="tv-keyboard-wrap">
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
