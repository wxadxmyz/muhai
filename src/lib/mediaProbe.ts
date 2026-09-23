// 媒体链路诊断日志（V3.6.8）。
//
// ## 为什么单独做一个缓冲，而不塞进 lib/debug.ts
//
// `debugLog` 记录的是**引擎请求**（苹果 CMS / 网盘 / drpy），用户搜索、点详情时才会写。
// 而播放器的问题出在**另一个进程**——Rust 侧的本地流式媒体代理（127.0.0.1:<port>）。
// 两者的日志混在一起会互相淹没：一部剧几十上百个 ts 分片，足够把引擎日志全挤掉。
//
// 所以这里独立成一个环形缓冲，只收媒体链路的事实：
//   · Rust 代理的真实请求记录（走 invoke('proxy_probe_snapshot') 取回）
//   · 前端这一侧自己观察到的事件（端口是否拿到、hls.js 报了什么错）
//
// 两者合并成一份报告，用户复制出来，开发者就能判断到底断在「WebView 没连上代理」
// 还是「连上了但上游返回 1 字节」还是「分片都到了但解码失败」。

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauriBridge';

/** Rust 侧一条代理请求记录，字段与 src-tauri/src/probe.rs 的 ProxyEvent 一一对应。 */
export interface ProxyEvent {
  seq: number;
  ts: number;
  url: string;
  method: string;
  client: string;
  status: number;
  range: string;
  fwd_range: string;
  body_len: number;
  m3u8: boolean;
  note: string;
}

/** Rust 侧累计计数：判断「有没有连上代理」最快的证据。 */
export interface ProxyCounters {
  total: number;
  upstream_ok: number;
  upstream_fail: number;
  range_dropped: number;
  recording: boolean;
}

export type MediaMarkKind = 'info' | 'ok' | 'warn' | 'fail';

/** 前端侧观察到的一条事件（端口、加载、hls.js 错误）。 */
export interface MediaMark {
  id: number;
  ts: number;
  kind: MediaMarkKind;
  /** 简短分类，如「代理端口」「加载」「网络错误」 */
  tag: string;
  /** 详情文本（会做长度截断） */
  text: string;
}

const MAX_MARKS = 300;
const MAX_TEXT = 400;

let marks: MediaMark[] = [];
let seq = 0;
const listeners = new Set<() => void>();
let cached: MediaMark[] | null = null;

function emit() {
  cached = null;
  for (const l of listeners) l();
}

/** 记录前端侧一条媒体链路事件。 */
export function markMedia(kind: MediaMarkKind, tag: string, text: string) {
  const t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
  const full: MediaMark = { id: ++seq, ts: Date.now(), kind, tag, text: t };
  marks = [...marks, full].slice(-MAX_MARKS);
  emit();
  // 同时打到 devtools 控制台（开发期用），Android 上不影响性能
  if (kind === 'fail') console.warn('[media]', tag, t);
  else console.log('[media]', tag, t);
}

export const mediaLog = {
  get(): MediaMark[] {
    if (cached === null) cached = marks.slice().reverse();
    return cached;
  },
  clear() {
    marks = [];
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** 格式化毫秒时间戳 → `HH:mm:ss.SSS` */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

function fmtSize(n: number): string {
  if (n < 0) return `流式(${-n} 声明)`;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 生成完整诊断报告。
 *
 * `extra` 用于塞入调用方特有的环境信息（播放地址、Referer、UA、video.readyState、
 * hls.js 最后的错误等）——这些是前端才知道、而 Rust 侧看不到的关键上下文。
 */
export async function buildMediaReport(extra?: Record<string, string>): Promise<string> {
  const lines: string[] = ['==== 幕海 媒体链路诊断报告 ====', `生成时间：${fmtTime(Date.now())}`];

  if (extra) {
    lines.push('\n--- 当前播放上下文 ---');
    for (const [k, v] of Object.entries(extra)) lines.push(`${k}：${v || '(空)'}`);
  }

  // ── 前端侧事件 ──
  lines.push('\n--- 播放器事件（前端观察）---');
  const mine = mediaLog.get();
  if (!mine.length) {
    lines.push('（无。播放一次后再复制，才有内容）');
  } else {
    // 倒序数组，打印时翻回时间正序更符合阅读习惯
    for (const m of mine.slice().reverse()) {
      lines.push(`[${fmtTime(m.ts)}] ${m.kind.toUpperCase().padEnd(4)} ${m.tag} · ${m.text}`);
    }
  }

  // ── Rust 侧事件 ──
  if (!isTauri()) {
    lines.push('\n--- 媒体代理（Rust）---');
    lines.push('（当前不是 Tauri 环境，无代理数据）');
    return lines.join('\n');
  }

  try {
    const raw = await invoke<string>('proxy_probe_snapshot', { limit: 200 });
    const parsed = JSON.parse(raw) as { events: ProxyEvent[]; counters: ProxyCounters };
    const c = parsed.counters;
    lines.push('\n--- 媒体代理累计计数 ---');
    lines.push(`代理收到请求总数：${c.total}`);
    lines.push(`上游 2xx 成功：${c.upstream_ok}　失败：${c.upstream_fail}`);
    lines.push(`Range 探测被丢弃：${c.range_dropped}`);
    lines.push(`事件记录开关：${c.recording ? '开' : '关'}`);
    if (c.total === 0) {
      lines.push('⚠️ 代理一次请求都没收到 —— 说明 WebView 根本没连上 127.0.0.1 代理。');
      lines.push('   这通常意味着：端口没拿到 / 明文流量被系统拦 / 端口已被回收。');
    } else if (c.upstream_fail > 0) {
      lines.push(`⚠️ 有 ${c.upstream_fail} 次上游失败 —— 源侧或网络问题，非播放器问题。`);
    }

    lines.push('\n--- 媒体代理请求明细（最近 200 条，时间正序）---');
    if (!parsed.events.length) {
      lines.push('（无事件）');
    } else {
      for (const e of parsed.events) {
        const parts = [
          `#${e.seq}`,
          fmtTime(e.ts),
          e.method,
          `HTTP ${e.status}`,
          fmtSize(e.body_len),
        ];
        if (e.range) parts.push(`range=${e.range}${e.fwd_range ? ` → 转发 ${e.fwd_range}` : ' → 已丢弃'}`);
        if (e.m3u8) parts.push('[m3u8]');
        if (e.note) parts.push(e.note);
        lines.push(parts.join(' | '));
        lines.push(`    ${e.url}`);
      }
    }
  } catch (e: any) {
    lines.push('\n--- 媒体代理（Rust）---');
    lines.push(`读取失败：${e?.message ?? e}`);
  }

  return lines.join('\n');
}

/** 清空两侧记录：前端事件 + Rust 代理事件/计数。 */
export async function clearMediaProbe(): Promise<void> {
  mediaLog.clear();
  if (!isTauri()) return;
  try {
    await invoke('proxy_probe_clear');
  } catch {
    /* ignore */
  }
}
