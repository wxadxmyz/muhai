// 播放器内的媒体链路诊断浮层（V3.6.8）。
//
// ## 为什么要有这个浮层
//
// 用户手机上坏的表现是「一直转圈 / 解码错误」，但开发机复现不了：
// 沙箱 Chromium 不带 H.264 专有解码器，「分片下载成功」之后的播放环节根本走不到。
// 于是唯一能拿到真相的地方就是**出问题的这台真机**——把关键事实画在屏幕上，
// 用户截图，开发者据实定位，不必再靠猜、也不必反复出新包试探。
//
// ## 显示什么（只放能区分病因的）
//
//   链路      当前走代理还是 fetchmedia 过桥，端口是多少
//   鉴权      Referer / UA 实际发出的值（首帧 Referer 污染会在这里现形）
//   播放器    readyState / 已缓冲秒数 / 分辨率（判断「数据到没到」）
//   代理      累计请求数、上游成败数、畸形 Range 转全量数（判断「WebView 连没连上」）
//   指纹      最近一条分片加载 + 最近一条致命错误（判断「网络错还是解码错」）
//
// 刻意不显示「字节/秒」这类噪声，用户看不过来，截图也不清楚。

import { useEffect, useState, useSyncExternalStore } from 'react';
import { mediaLog, type MediaMark } from '../lib/mediaProbe';
import { getSettings } from '../lib/settings';
import { isTauri } from '../lib/tauriBridge';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';

export interface MediaProbeInfo {
  /** 实际交给播放器的 URL（代理地址或真实地址） */
  playUrl: string;
  /** 解析出的防盗链请求头 */
  headers?: Record<string, string> | null;
  /** 容器容器（用于读播放器实时状态） */
  video: HTMLVideoElement | null;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
  );
}

const KIND_COLOR: Record<string, string> = {
  info: '#8ab4f8',
  ok: '#5ddc9a',
  warn: '#ffcf5c',
  fail: '#ff7a7a',
};

export function MediaProbeOverlay({ playUrl, headers, video }: MediaProbeInfo) {
  const marks = useSyncExternalStore(mediaLog.subscribe, mediaLog.get);
  // 每 500ms 轮询一次播放器实时状态（readyState / buffered / 分辨率）。
  // 用轮询而不是挂事件，是因为「卡住不动」本身就是关键现象——事件恰好不会触发。
  const [, tick] = useState(0);
  const [counters, setCounters] = useState<string>('读取中…');
  // 版本号从 Tauri 读，避免浮层里硬编码——否则每次升版都要记得改这里。
  const [ver, setVer] = useState('');

  useEffect(() => {
    if (!isTauri()) return;
    getVersion()
      .then((v) => setVer(v))
      .catch(() => setVer(''));
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      setCounters('非 Tauri 环境，无代理数据');
      return;
    }
    let alive = true;
    const pull = async () => {
      try {
        const raw = await invoke<string>('proxy_probe_snapshot', { limit: 1 });
        const c = JSON.parse(raw).counters;
        if (!alive) return;
        setCounters(
          `代理请求 ${c.total}｜上游 成功 ${c.upstream_ok} / 失败 ${c.upstream_fail}｜畸形 Range 转全量 ${c.range_dropped}`
        );
      } catch (e: any) {
        if (alive) setCounters('读取失败：' + (e?.message ?? e));
      }
    };
    pull();
    const t = window.setInterval(pull, 1000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  let isProxy = false;
  let port = '';
  try {
    const u = new URL(playUrl);
    if (u.hostname === '127.0.0.1' && u.pathname === '/proxy') {
      isProxy = true;
      port = u.port;
    }
  } catch {
    /* ignore */
  }

  // 播放器实时状态
  let vState = '（播放器未就绪）';
  if (video) {
    let bufEnd = 0;
    try {
      if (video.buffered.length) bufEnd = video.buffered.end(video.buffered.length - 1);
    } catch {
      /* ignore */
    }
    vState =
      `readyState=${video.readyState}` +
      ` t=${video.currentTime.toFixed(2)}` +
      ` 时长=${Number.isFinite(video.duration) ? video.duration.toFixed(1) : '-'}` +
      ` 已缓冲=${bufEnd.toFixed(1)}s` +
      ` 分辨率=${video.videoWidth || 0}x${video.videoHeight || 0}` +
      `${video.paused ? ' 已暂停' : ' 播放中'}`;
  }

  // 取最近一条「分片完成」与最近一条「致命错误」做指纹
  const lastFrag = marks.find((m) => m.tag === '分片完成');
  const lastErr = marks.find((m) => m.kind === 'fail');
  const shown: MediaMark[] = marks.slice(0, 14);

  let settingsDump = '读取失败';
  try {
    const s = getSettings();
    settingsDump = `useMediaProxy=${s.useMediaProxy} 硬解=${s.hardwareDecode} 缩放=${s.videoScale}`;
  } catch {
    /* ignore */
  }

  return (
    <div className="media-probe">
      <div className="mp-head">
        媒体链路诊断{ver ? ` · v${ver}` : ''}
        <span className="mp-hint">截图发开发者</span>
      </div>

      <div className="mp-line">
        <b>链路</b> {isProxy ? `本地代理 127.0.0.1:${port}` : playUrl ? '直连 / fetchmedia 过桥' : '无地址'}
      </div>
      <div className="mp-line">
        <b>设置</b> {settingsDump}
      </div>
      <div className="mp-line mp-break">
        <b>地址</b> {playUrl || '(空)'}
      </div>
      <div className="mp-line mp-break">
        <b>Referer</b> {headers?.Referer || '(无)'}
      </div>
      <div className="mp-line mp-break">
        <b>UA</b> {(headers?.['User-Agent'] || '(无)').slice(0, 80)}
      </div>
      <div className="mp-line">
        <b>播放器</b> {vState}
      </div>
      <div className="mp-line mp-break">
        <b>代理</b> {counters}
      </div>
      {lastFrag && (
        <div className="mp-line">
          <b>最近分片</b> <span style={{ color: KIND_COLOR.ok }}>{lastFrag.text}</span>
        </div>
      )}
      {lastErr && (
        <div className="mp-line mp-break">
          <b>最近错误</b> <span style={{ color: KIND_COLOR.fail }}>{lastErr.tag} · {lastErr.text}</span>
        </div>
      )}

      <div className="mp-list">
        {shown.length === 0 && <div className="mp-empty">暂无事件，播放几秒后会填充。</div>}
        {shown.map((m) => (
          <div className="mp-ev" key={m.id}>
            <span className="mp-ts">{fmtTime(m.ts)}</span>
            <span className="mp-tag" style={{ color: KIND_COLOR[m.kind] }}>
              {m.tag}
            </span>
            <span className="mp-txt">{m.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
