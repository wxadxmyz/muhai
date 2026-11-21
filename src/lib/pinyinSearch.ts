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

/** 输入字母串是否按顺序作为子序列出现在拼音串里（如 "fcwq" 命中 "fengchuangweiqi"）。 */
function isSubseq(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

/** 按输入串匹配候选剧名：① 拼音首字母前缀 → ② 剧名子串 → ③ 拼音子序列模糊（V4.4.3 #12）。
 *  ③ 是关键兜底：用户常只记得大概首字母（如 FCWQ），词库里未必有严格前缀命中的词，
 *  子序列匹配能把「拼音里依次含这些字母」的词都列出来，右侧联想墙不再空白。 */
export function matchPinyin(query: string, index: PinyinEntry[]): string[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) return index.map((e) => e.name);
  const byPy: string[] = [];
  const byName: string[] = [];
  const bySubseq: string[] = [];
  for (const e of index) {
    if (e.py.startsWith(q)) byPy.push(e.name);
    else if (e.name.toLowerCase().includes(q)) byName.push(e.name);
    else if (q.length >= 2 && isSubseq(q, e.py)) bySubseq.push(e.name);
  }
  const merged = byPy.concat(byName, bySubseq);
  return Array.from(new Set(merged));
}
