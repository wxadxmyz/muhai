import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

export interface Skin {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  swatch: string;
  vars: Record<string, string>;
}

// 多套完整皮肤：每套包含底色模式 + 主色 + 背景质感（通过 CSS 变量整体切换）
export const SKINS: Skin[] = [
  {
    id: 'night',
    name: '暗夜黑',
    mode: 'dark',
    swatch: 'linear-gradient(135deg,#1e2230,#0d0f14)',
    vars: {
      '--bg': '#0d0f14',
      '--panel': '#161922',
      '--panel2': '#1e2230',
      '--panel3': '#262b3b',
      '--text': '#e8eaf0',
      '--muted': '#9aa1ad',
      '--border': '#272c39',
      '--danger': '#ff5b6e',
      '--ok': '#3ddc84',
      '--accent': '#6a8cff',
      '--accent2': '#b15bff',
      '--shadow': '0 8px 30px rgba(0,0,0,.45)',
    },
  },
  {
    id: 'sakura',
    name: '樱花粉',
    mode: 'light',
    swatch: 'linear-gradient(135deg,#ff9ad1,#ff6fae)',
    vars: {
      '--bg': '#fdeef5',
      '--panel': '#ffffff',
      '--panel2': '#fbe3ee',
      '--panel3': '#f4cfe0',
      '--text': '#4a2a39',
      '--muted': '#a06b85',
      '--border': '#f0c9dc',
      '--danger': '#ff5b7e',
      '--ok': '#2fb47a',
      '--accent': '#ff6fae',
      '--accent2': '#ff9ad1',
      '--shadow': '0 8px 30px rgba(120,40,90,.18)',
    },
  },
  {
    id: 'aurora',
    name: '极光蓝',
    mode: 'dark',
    swatch: 'linear-gradient(135deg,#28c0ff,#5b8cff)',
    vars: {
      '--bg': '#0a1018',
      '--panel': '#111a26',
      '--panel2': '#16202f',
      '--panel3': '#1e2b3d',
      '--text': '#dceaf5',
      '--muted': '#7e93a8',
      '--border': '#1c2a3a',
      '--danger': '#ff6b7d',
      '--ok': '#36e0c0',
      '--accent': '#28c0ff',
      '--accent2': '#5b8cff',
      '--shadow': '0 8px 30px rgba(0,0,0,.5)',
    },
  },
  {
    id: 'mint',
    name: '薄荷绿',
    mode: 'light',
    swatch: 'linear-gradient(135deg,#5bd6a0,#21c08a)',
    vars: {
      '--bg': '#eef7f1',
      '--panel': '#ffffff',
      '--panel2': '#e3f3ea',
      '--panel3': '#d2ecdd',
      '--text': '#234a38',
      '--muted': '#6b9a82',
      '--border': '#cfe9da',
      '--danger': '#ff6b6b',
      '--ok': '#2bb673',
      '--accent': '#21c08a',
      '--accent2': '#5bd6a0',
      '--shadow': '0 8px 30px rgba(40,120,90,.16)',
    },
  },
  {
    id: 'grape',
    name: '葡萄紫',
    mode: 'dark',
    swatch: 'linear-gradient(135deg,#a36bff,#6b8cff)',
    vars: {
      '--bg': '#120e1e',
      '--panel': '#1b1430',
      '--panel2': '#241a3d',
      '--panel3': '#2e2150',
      '--text': '#ece6fb',
      '--muted': '#9b8ec0',
      '--border': '#2c2048',
      '--danger': '#ff6f9f',
      '--ok': '#6ce0b0',
      '--accent': '#a36bff',
      '--accent2': '#6b8cff',
      '--shadow': '0 8px 30px rgba(30,10,60,.5)',
    },
  },
  {
    id: 'sunset',
    name: '落日橙',
    mode: 'light',
    swatch: 'linear-gradient(135deg,#ffb15b,#ff8a3d)',
    vars: {
      '--bg': '#fff3ea',
      '--panel': '#ffffff',
      '--panel2': '#ffe6d4',
      '--panel3': '#ffd6bd',
      '--text': '#5a3320',
      '--muted': '#b07a55',
      '--border': '#ffd8c0',
      '--danger': '#ff5b5b',
      '--ok': '#2bb673',
      '--accent': '#ff8a3d',
      '--accent2': '#ffb15b',
      '--shadow': '0 8px 30px rgba(160,90,40,.16)',
    },
  },
  {
    id: 'volcano',
    name: '火山红',
    mode: 'dark',
    swatch: 'linear-gradient(135deg,#ff9b5b,#ff5b6e)',
    vars: {
      '--bg': '#160c0e',
      '--panel': '#221216',
      '--panel2': '#2e191d',
      '--panel3': '#3b2127',
      '--text': '#fbe6e8',
      '--muted': '#c08a90',
      '--border': '#3a2227',
      '--danger': '#ff5b6e',
      '--ok': '#4fd6a0',
      '--accent': '#ff5b6e',
      '--accent2': '#ff9b5b',
      '--shadow': '0 8px 30px rgba(60,10,15,.5)',
    },
  },
];

const KEY = 'mps_skin'; // 当前选择（可为 'auto' 或具体皮肤 id）
const KEY_DARK = 'mps_skin_dark'; // 跟随系统时使用的暗色皮肤（记忆用户最近选的暗色）
const KEY_LIGHT = 'mps_skin_light'; // 跟随系统时使用的亮色皮肤（记忆用户最近选的亮色）

function getSystemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

interface Ctx {
  skin: Skin; // 当前实际生效的皮肤
  selectedId: string; // 用户原始选择（'auto' 或具体皮肤 id）
  isAuto: boolean; // 是否处于“跟随系统”模式
  systemMode: 'dark' | 'light'; // 当前系统偏好
  setSkinId: (id: string) => void;
}
const ThemeCtx = createContext<Ctx>({ skin: SKINS[0], selectedId: 'night', isAuto: false, systemMode: 'dark', setSkinId: () => {} });

function apply(skin: Skin) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(skin.vars)) root.style.setProperty(k, v);
  root.style.colorScheme = skin.mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedId] = useState<string>(() => localStorage.getItem(KEY) || 'night');
  const [systemDark, setSystemDark] = useState<boolean>(getSystemDark);

  // 跟随系统时：按系统明暗选用记忆的暗/亮色皮肤；手动选择：用所选皮肤
  const resolvedId = selectedId === 'auto'
    ? (systemDark
        ? localStorage.getItem(KEY_DARK) || 'night'
        : localStorage.getItem(KEY_LIGHT) || 'sakura')
    : selectedId;
  const skin = SKINS.find((s) => s.id === resolvedId) || SKINS[0];

  // 监听系统明暗变化，自动切换
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setSkinId = (id: string) => {
    if (id === 'auto') {
      localStorage.setItem(KEY, 'auto');
      setSelectedId('auto');
    } else {
      const s = SKINS.find((x) => x.id === id);
      if (!s) return;
      // 记忆用户最近选的暗/亮色皮肤，供“跟随系统”使用
      if (s.mode === 'dark') localStorage.setItem(KEY_DARK, id);
      else localStorage.setItem(KEY_LIGHT, id);
      localStorage.setItem(KEY, id);
      setSelectedId(id);
    }
  };

  useEffect(() => {
    apply(skin);
  }, [skin]);

  const ctx: Ctx = {
    skin,
    selectedId,
    isAuto: selectedId === 'auto',
    systemMode: systemDark ? 'dark' : 'light',
    setSkinId,
  };
  return <ThemeCtx.Provider value={ctx}>{children}</ThemeCtx.Provider>;
}

export const useSkin = () => useContext(ThemeCtx);
