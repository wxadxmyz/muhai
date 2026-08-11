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
  return t ? t.charAt(0) : '?';
}
