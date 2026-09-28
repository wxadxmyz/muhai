// 电视端软键盘「拼音首字母联想」助手（清单 §3.3）。
//
// TV 没有物理键盘，搜索靠 A-Z / 0-9 软键盘逐键输入拼音首字母（如 "dsj" → 电视剧）。
// 这里把剧名目录构建成「归一化拼音首字母」索引，输入串做前缀匹配；同时兼容直接输入中文/数字子串。
//
// 仅依赖 pinyin-pro（已装），纯前端、无后端依赖；目录来自首页 HotData + 搜索历史，
// 覆盖绝大多数点播场景。真要全站搜仍走软键盘「搜索」键（全站 aggregateSearch）。

import { pinyin } from 'pinyin-pro';

export interface PinyinEntry {
  name: string;
  py: string; // 拼音首字母串（小写，不含声调），如 "斗破苍穹" → "dbcq"
}

/** 由一组剧名构建索引（去重）。 */
export function buildPinyinIndex(names: string[]): PinyinEntry[] {
  const seen = new Set<string>();
  const out: PinyinEntry[] = [];
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    let py = '';
    try {
      py = (pinyin(name, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' }) as string[])
        .join('')
        .toLowerCase();
    } catch {
      py = '';
    }
    out.push({ name, py });
  }
  return out;
}

/** 按输入串匹配候选剧名：优先拼音首字母前缀，其次剧名子串包含。 */
export function matchPinyin(query: string, index: PinyinEntry[]): string[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) return index.map((e) => e.name);
  const byPy: string[] = [];
  const byName: string[] = [];
  for (const e of index) {
    if (e.py.startsWith(q)) byPy.push(e.name);
    else if (e.name.toLowerCase().includes(q)) byName.push(e.name);
  }
  const merged = byPy.concat(byName);
  return Array.from(new Set(merged));
}
