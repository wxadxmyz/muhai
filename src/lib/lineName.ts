// V4.5.3：线路显示名工具。
// 规则侧已把 vod_play_from 解析进 raw.lineNames（普通站是站点自己的线路名，如 liangzi/lzm3u8；
// 网盘站是「夸克网盘 / UC网盘 / 阿里云盘 / 百度网盘 / 迅雷云盘」这类中文名）。
// TV 详情页线路栏原先写死「线路1/线路2」，这里统一读站点线路名，网盘站再套一层谐音，
// 既满足「普通站用站点自己的线路名」，也满足「网盘站显示夸父/优夕等谐音」。

const DISH_MAP: Record<string, string> = {
  '夸克网盘': '夸父',
  '夸克': '夸父',
  'quark': '夸父',
  'uc网盘': '优夕',
  'uc': '优夕',
  '阿里云盘': '阿礼',
  '阿里': '阿礼',
  'ali': '阿礼',
  '百度网盘': '百渡',
  '百度': '百渡',
  'baidu': '百渡',
  '迅雷云盘': '迅垒',
  '迅雷': '迅垒',
  'xunlei': '迅垒',
};

/** 返回某条线路用于显示的文字名。 */
export function lineDisplayName(raw: any, index: number): string {
  const names = raw?.lineNames as string[] | undefined;
  const rawName = names?.[index];
  if (!rawName) return `线路${index + 1}`;
  // 网盘名 → 谐音（大小写/空格归一）
  const key = rawName.trim().toLowerCase().replace(/\s+/g, '');
  return DISH_MAP[key] || rawName;
}

/** 判断某条线路是否为网盘线路（用于决定要不要弹授权）。返回 provider key 或 null。 */
export function lineNetdiskKey(raw: any, index: number): 'ali' | 'quark' | 'uc' | 'baidu' | 'xunlei' | null {
  const names = raw?.lineNames as string[] | undefined;
  const rawName = (names?.[index] || '').trim().toLowerCase().replace(/\s+/g, '');
  if (/夸克|quark/.test(rawName)) return 'quark';
  if (/^uc|uc网盘/.test(rawName)) return 'uc';
  if (/阿里|ali/.test(rawName)) return 'ali';
  if (/百度|baidu/.test(rawName)) return 'baidu';
  if (/迅雷|xunlei/.test(rawName)) return 'xunlei';
  return null;
}
