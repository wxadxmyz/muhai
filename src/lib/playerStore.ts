import { useSyncExternalStore } from 'react';
import { MediaItem } from '../engine/types';

export type PlayMode = 'list' | 'one' | 'shuffle';

interface PlayerState {
  current: MediaItem | null;
  queue: MediaItem[];
  index: number;
  isPlaying: boolean;
  progress: number; // 秒
  duration: number; // 秒
  volume: number; // 0~1
  muted: boolean;
  mode: PlayMode;
}

// 媒体元素引用（模块级，便于跨组件控制进度）
let audioElRef: HTMLAudioElement | null = null;
let videoElRef: HTMLVideoElement | null = null;

let state: PlayerState = {
  current: null,
  queue: [],
  index: -1,
  isPlaying: false,
  progress: 0,
  duration: 0,
  volume: 0.9,
  muted: false,
  mode: 'list',
};

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  emit();
}

function pickNext(): number {
  const n = state.queue.length;
  if (n === 0) return -1;
  if (state.mode === 'shuffle') return Math.floor(Math.random() * n);
  let i = state.index + 1;
  if (i >= n) i = 0;
  return i;
}

function pickPrev(): number {
  const n = state.queue.length;
  if (n === 0) return -1;
  if (state.mode === 'shuffle') return Math.floor(Math.random() * n);
  let i = state.index - 1;
  if (i < 0) i = n - 1;
  return i;
}

export const player = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  getState() {
    return state;
  },

  playItem(item: MediaItem) {
    setState({ current: item, isPlaying: true, progress: 0, duration: 0, index: -1, queue: [] });
  },

  playQueue(items: MediaItem[], startIndex = 0) {
    if (items.length === 0) return;
    const idx = Math.max(0, Math.min(startIndex, items.length - 1));
    setState({ queue: items, index: idx, current: items[idx], isPlaying: true, progress: 0, duration: 0 });
  },

  enqueue(items: MediaItem[]) {
    const queue = [...state.queue, ...items];
    const patch: Partial<PlayerState> = { queue };
    if (!state.current) {
      patch.current = queue[0];
      patch.index = 0;
      patch.isPlaying = true;
    }
    setState(patch);
  },

  toggle() {
    if (!state.current) return;
    setState({ isPlaying: !state.isPlaying });
  },

  next() {
    const i = pickNext();
    if (i < 0) return;
    setState({ index: i, current: state.queue[i], isPlaying: true, progress: 0, duration: 0 });
  },

  prev() {
    if (state.progress > 3) {
      setState({ progress: 0 });
      return;
    }
    const i = pickPrev();
    if (i < 0) return;
    setState({ index: i, current: state.queue[i], isPlaying: true, progress: 0, duration: 0 });
  },

  playAt(index: number) {
    if (index < 0 || index >= state.queue.length) return;
    setState({ index, current: state.queue[index], isPlaying: true, progress: 0, duration: 0 });
  },

  updateCurrent(item: MediaItem) {
    if (!state.current) return;
    setState({ current: { ...state.current, ...item, id: state.current.id, sourceId: state.current.sourceId } });
  },

  clearQueue() {
    setState({ queue: [], index: -1, current: null, isPlaying: false });
  },

  // 队列重排（拖拽）
  reorderQueue(from: number, to: number) {
    const q = [...state.queue];
    if (from < 0 || to < 0 || from >= q.length || to >= q.length) return;
    const [moved] = q.splice(from, 1);
    q.splice(to, 0, moved);
    let index = state.index;
    if (state.index === from) index = to;
    else if (from < state.index && to >= state.index) index--;
    else if (from > state.index && to <= state.index) index++;
    setState({ queue: q, index });
  },

  removeFromQueue(i: number) {
    const q = state.queue.filter((_, k) => k !== i);
    let index = state.index;
    if (i < state.index) index--;
    else if (i === state.index) index = Math.max(0, Math.min(index, q.length - 1));
    setState({
      queue: q,
      index,
      current: q[index] ?? null,
      isPlaying: q.length > 0,
    });
  },

  enqueueAt(item: MediaItem, at: number) {
    const q = [...state.queue];
    q.splice(at, 0, item);
    let index = state.index;
    if (at <= state.index) index++;
    setState({ queue: q, index });
  },

  attachAudio(el: HTMLAudioElement | null) {
    audioElRef = el;
  },
  attachVideo(el: HTMLVideoElement | null) {
    videoElRef = el;
  },

  seek(t: number) {
    setState({ progress: t });
    if (audioElRef) audioElRef.currentTime = t;
    if (videoElRef) videoElRef.currentTime = t;
  },
  setDuration(d: number) {
    if (d !== state.duration) setState({ duration: d });
  },
  setProgress(p: number) {
    if (Math.abs(p - state.progress) > 0.25) setState({ progress: p });
  },
  setVolume(v: number) {
    setState({ volume: v, muted: v === 0 });
  },
  setMuted(m: boolean) {
    setState({ muted: m });
  },
  setMode(m: PlayMode) {
    setState({ mode: m });
  },

  onEnded() {
    if (state.mode === 'one' && state.current) {
      setState({ progress: 0, isPlaying: true });
    } else {
      player.next();
    }
  },
};

export function usePlayer() {
  return useSyncExternalStore(player.subscribe, player.getState);
}

// 供频谱可视化读取真实 <audio> 元素
export function getAudioElement(): HTMLAudioElement | null {
  return audioElRef;
}

export function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
