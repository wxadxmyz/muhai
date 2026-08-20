import { useState, useEffect, useRef } from 'react';
import Hls from 'hls.js';
import { invoke } from '@tauri-apps/api/core';
import { aggregateLives } from '../../engine';
import { SourceConfig, LiveChannelSource } from '../../engine/types';
import { Icon } from '../../components/Icon';

interface Channel {
  name: string;
  url: string;
  logo?: string;
}

// 拉取文本：优先走 Rust 后端 fetchsource 代理（绕开 WebView CORS），失败回退 fetch
async function fetchText(url: string): Promise<string> {
  try {
    return await invoke<string>('fetchsource', { url });
  } catch {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}

// 解析 m3u / txt 直播列表为频道名+地址+台标
function parseM3U(text: string): Channel[] {
  const lines = text.split(/\r?\n/);
  const channels: Channel[] = [];
  let name = '';
  let logo = '';
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith('#EXTINF')) {
      const logoMatch = t.match(/tvg-logo="([^"]*)"/i);
      logo = logoMatch ? logoMatch[1] : '';
      const idx = t.lastIndexOf(',');
      name = idx >= 0 ? t.slice(idx + 1).trim() : '';
    } else if (t && !t.startsWith('#') && /^https?:\/\//.test(t)) {
      channels.push({ name: name || t, url: t, logo });
      name = '';
      logo = '';
    }
  }
  return channels;
}

export function Live({ sources, onOpenSources }: { sources: SourceConfig[]; onOpenSources: () => void }) {
  const [lives, setLives] = useState<(LiveChannelSource & { sourceName: string })[]>([]);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [activeName, setActiveName] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!sources.length) {
      setLives([]);
      setChannels(null);
      return;
    }
    setError('');
    aggregateLives(sources)
      .then((r) => {
        const flat = r.groups.flatMap((g) => g.channels.map((c) => ({ ...c, sourceName: g.sourceName })));
        setLives(flat);
        if (!flat.length) setError('未检测到可用直播源（需导入含 lives[] 的 tvbox 配置，如影视仓 XC.json）');
      })
      .catch(() => setError('直播源加载失败'));
  }, [sources]);

  // m3u8 在 Android WebView 原生 <video> 大多无法直接播放，统一用 hls.js 解封装；
  // 非 HLS 地址（mp4 等）走原生 src。
  useEffect(() => {
    if (!playing || !videoRef.current) return;
    const video = videoRef.current;
    const isHls = /\.m3u8(\?|$)/i.test(playing);
    let hls: Hls | null = null;
    if (isHls && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playing; // iOS / Safari 原生 HLS
    } else if (isHls && Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(playing);
      hls.attachMedia(video);
    } else {
      video.src = playing;
    }
    return () => {
      if (hls) hls.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [playing]);

  const openLive = async (live: LiveChannelSource & { sourceName: string }) => {
    setLoading(true);
    setError('');
    setActiveName(live.name);
    try {
      const text = await fetchText(live.url);
      const ch = parseM3U(text);
      if (ch.length) setChannels(ch);
      else setError('该直播地址解析为空，可能需代理或已失效');
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="view live">
      <div className="search-bar big">
        <span className="search-ico">
          <Icon name="cast" size={18} />
        </span>
        <input placeholder="直播频道来自已添加的源" readOnly />
      </div>

      {channels ? (
        <div className="live-channels">
          <div className="live-back tap" onClick={() => { setChannels(null); setPlaying(null); }}>
            ‹ {activeName}
          </div>
          <div className="poster-grid">
            {channels.map((c, i) => (
              <div key={i} className="pcard tap" onClick={() => setPlaying(c.url)}>
                <div className="pcover">
                  {c.logo ? <img src={c.logo} alt="" /> : <span className="ph-big">{c.name.slice(0, 1)}</span>}
                </div>
                <div className="ptitle">{c.name}</div>
              </div>
            ))}
          </div>
        </div>
      ) : lives.length ? (
        <div className="live-list">
          {lives.map((l, i) => (
            <div key={i} className="settings-row tap" onClick={() => openLive(l)}>
              <span className="ico">
                <Icon name="cast" size={20} />
              </span>
              <span className="label">{l.name}</span>
              <span className="value muted">{l.sourceName}</span>
              <span className="chevron">
                <Icon name="arrow-right" size={18} />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="blank-state">
          <div className="blank-art">
            <Icon name="cast" size={44} />
          </div>
          <h2>{error || '直播源未配置'}</h2>
          <p className="muted">
            直播线路来自你导入的 tvbox 配置中的 lives[]。<br />
            导入含直播线路的源后，这里即可观看。
          </p>
          <button className="primary" onClick={onOpenSources}>
            去源管理添加
          </button>
        </div>
      )}

      {loading && <div className="empty sm">正在加载直播频道…</div>}

      {playing && (
        <div className="live-player">
          <video ref={videoRef} controls autoPlay playsInline className="live-video" />
          <button className="live-close" onClick={() => setPlaying(null)}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
