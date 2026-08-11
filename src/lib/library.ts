import { useCallback, useEffect, useState } from 'react';
import { MediaItem } from '../engine/types';

const PREFIX = 'mps_lib_';

export interface Playlist {
  id: string;
  name: string;
  items: MediaItem[];
}

export interface LibraryState {
  history: MediaItem[]; // 最近播放/观看，最新在前
  favorites: MediaItem[]; // 收藏
  playlists: Playlist[];
  searchHistory: string[]; // 搜索历史
  watchProgress: Record<string, number>; // 影视观看进度（秒）
  localMusic: MediaItem[]; // 本地导入
}

function uid() {
  return 'p_' + Math.random().toString(36).slice(2, 9);
}

function keyOf(it: MediaItem) {
  return `${it.sourceId}:${it.id}`;
}

function load(appKey: string): LibraryState {
  try {
    const raw = localStorage.getItem(PREFIX + appKey);
    if (raw) return { history: [], favorites: [], playlists: [], searchHistory: [], watchProgress: {}, localMusic: [], ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { history: [], favorites: [], playlists: [], searchHistory: [], watchProgress: {}, localMusic: [] };
}

export function useLibrary(appKey: string) {
  const [lib, setLib] = useState<LibraryState>(() => load(appKey));

  useEffect(() => {
    localStorage.setItem(PREFIX + appKey, JSON.stringify(lib));
  }, [lib, appKey]);

  const addHistory = useCallback((item: MediaItem) => {
    setLib((l) => {
      const k = keyOf(item);
      const rest = l.history.filter((x) => keyOf(x) !== k);
      return { ...l, history: [item, ...rest].slice(0, 60) };
    });
  }, []);

  const addSearch = useCallback((kw: string) => {
    const t = kw.trim();
    if (!t) return;
    setLib((l) => ({ ...l, searchHistory: [t, ...l.searchHistory.filter((x) => x !== t)].slice(0, 20) }));
  }, []);

  const clearSearch = useCallback(() => setLib((l) => ({ ...l, searchHistory: [] })), []);

  const toggleFavorite = useCallback((item: MediaItem) => {
    setLib((l) => {
      const k = keyOf(item);
      const exists = l.favorites.some((x) => keyOf(x) === k);
      return exists
        ? { ...l, favorites: l.favorites.filter((x) => keyOf(x) !== k) }
        : { ...l, favorites: [item, ...l.favorites] };
    });
  }, []);

  const isFavorite = useCallback(
    (item: MediaItem) => lib.favorites.some((x) => keyOf(x) === keyOf(item)),
    [lib.favorites]
  );

  const createPlaylist = useCallback((name: string) => {
    setLib((l) => ({ ...l, playlists: [...l.playlists, { id: uid(), name: name || '我的歌单', items: [] }] }));
  }, []);

  const removePlaylist = useCallback((pid: string) => {
    setLib((l) => ({ ...l, playlists: l.playlists.filter((p) => p.id !== pid) }));
  }, []);

  const addToPlaylist = useCallback((pid: string, item: MediaItem) => {
    setLib((l) => ({
      ...l,
      playlists: l.playlists.map((p) =>
        p.id === pid && !p.items.some((x) => keyOf(x) === keyOf(item))
          ? { ...p, items: [...p.items, item] }
          : p
      ),
    }));
  }, []);

  const removeFromPlaylist = useCallback((pid: string, item: MediaItem) => {
    setLib((l) => ({
      ...l,
      playlists: l.playlists.map((p) =>
        p.id === pid ? { ...p, items: p.items.filter((x) => keyOf(x) !== keyOf(item)) } : p
      ),
    }));
  }, []);

  const setWatchProgress = useCallback((id: string, seconds: number) => {
    setLib((l) => ({ ...l, watchProgress: { ...l.watchProgress, [id]: Math.floor(seconds) } }));
  }, []);

  const clearHistory = useCallback(() => setLib((l) => ({ ...l, history: [] })), []);

  const addLocalMusic = useCallback((items: MediaItem[]) => {
    setLib((l) => ({ ...l, localMusic: [...items, ...l.localMusic] }));
  }, []);

  return {
    lib,
    addHistory,
    addSearch,
    clearSearch,
    toggleFavorite,
    isFavorite,
    createPlaylist,
    removePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    setWatchProgress,
    clearHistory,
    addLocalMusic,
  };
}
