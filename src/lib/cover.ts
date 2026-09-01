export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function gradientFor(s: string): string {
  const h = hashHue(s || 'x');
  return `linear-gradient(135deg, hsl(${h} 55% 42%), hsl(${(h + 50) % 360} 60% 30%))`;
}

export function initial(s: string): string {
  const t = (s || '?').trim();
  // ⑮ v3.2.0：显示前两个字（如"庆余"），比单个大字更好看
  return t ? t.slice(0, 2) : '?';
}
