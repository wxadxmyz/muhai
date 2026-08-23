import { useState, useEffect, useRef, useMemo } from 'react';
import Hls from 'hls.js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { aggregateLives } from '../../engine';
import { SourceConfig, LiveChannelSource } from '../../engine/types';
import { Icon } from '../../components/Icon';

interface Channel {
  name: string;
  url: string;
  logo?: string;
  group?: string;
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

// 解析 m3u / txt 直播列表为频道名+地址+台标+分组
function parseM3U(text: string): Channel[] {
  const lines = text.split(/\r?\n/);
  const channels: Channel[] = [];
  let name = '';
  let logo = '';
  let group = '';
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith('#EXTINF')) {
      const logoMatch = t.match(/tvg-logo="([^"]*)"/i);
      logo = logoMatch ? logoMatch[1] : '';
      const groupMatch = t.match(/group-title="([^"]*)"/i);
      group = groupMatch ? groupMatch[1] : '';
      const idx = t.lastIndexOf(',');
      name = idx >= 0 ? t.slice(idx + 1).trim() : '';
    } else if (t && !t.startsWith('#')) {
      // 标准 EXTINF 后的直链，或纯文本 "名称,url" 格式（如 CCTV1,http://...）
      let url = '';
      if (/^https?:\/\//.test(t)) {
        url = t;
      } else {
        const m = t.match(/,\s*(https?:\/\/\S+)\s*$/);
        if (m) {
          url = m[1];
          if (!name) name = t.slice(0, t.lastIndexOf(',')).trim();
        }
      }
      if (url) {
        channels.push({ name: name || url, url, logo, group });
        name = '';
        logo = '';
        group = '';
      }
    }
  }
  return channels;
}

const ALL_CAT = '推荐';

// 问题 #3 修复：部分 IPTV 源需要 Referer / UA 才返回 200，否则 403。
// 这里给 hls.js 拉流统一带上常见 Header（Referer 用源站 host，UA 用 okhttp）。
// 后续若源配置里有自定义 headers，可在此合并。
function streamHeaders(url: string): Record<string, string> {
  let ref = '';
  try {
    ref = new URL(url).origin;
  } catch {
    /* ignore */
  }
  return {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    Referer: ref || 'https://www.google.com',
  };
}

export function Live({ sources, onOpenSources }: { sources: SourceConfig[]; onOpenSources: () => void }) {
  const [lives, setLives] = useState<(LiveChannelSource & { sourceName: string })[]>([]);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [activeName, setActiveName] = useState('');
  const [playing, setPlaying] = useState<{ url: string; name: string } | null>(null);
  const [activeCat, setActiveCat] = useState(ALL_CAT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // 点击 video 或按钮切换播放/暂停
  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) { el.play(); setPaused(false); }
    else { el.pause(); setPaused(true); }
  };

  // 真正的全屏/横屏：先尝试屏幕方向锁定，再尝试 HTML5 fullscreen API
  const toggleFullscreen = async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      const screen = (window as any).screen;
      if (screen?.orientation?.lock) {
        await screen.orientation.lock('landscape');
      }
      const docEl = document.documentElement as any;
      if (!document.fullscreenElement && el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (docEl?.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      }
      setIsFullscreen(!document.fullscreenElement);
    } catch {
      /* 部分环境不支持，忽略 */
    }
  };

  // 问题 #8 修复（直播二级）：当处于频道列表态（channels 不为 null）且未在播放时，
  // 系统返回手势应先退回源列表（setChannels(null)），而不是直接回主页。
  useEffect(() => {
    const prev = (window as any).__onAndroidBack;
    (window as any).__onAndroidBack = () => {
      if (channels && !playing) {
        setChannels(null);
        setActiveName('');
        return false; // 已逐级退一层，拦截系统返回
      }
      return prev ? !!prev() : true;
    };
    return () => {
      (window as any).__onAndroidBack = prev;
    };
  }, [channels, playing]);

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
  // 非 HLS 地址（mp4 等）走原生 src。hls.js 拉流携带 Referer/UA 以兼容需鉴权的 IPTV 源。
  useEffect(() => {
    if (!playing || !videoRef.current) return;
    const el = videoRef.current;
    const isHls = /\.m3u8(\?|$)/i.test(playing.url);
    const hdrs = streamHeaders(playing.url);
    let hls: Hls | null = null;
    if (isHls && el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = playing.url; // iOS / Safari 原生 HLS
    } else if (isHls && Hls.isSupported()) {
      hls = new Hls({
        xhrSetup: (xhr: XMLHttpRequest, u: string) => {
          for (const [k, v] of Object.entries(streamHeaders(u))) xhr.setRequestHeader(k, v);
        },
      });
      hls.loadSource(playing.url);
      hls.attachMedia(el);
    } else {
      el.src = playing.url;
    }
    return () => {
      if (hls) hls.destroy();
      el.removeAttribute('src');
      el.load();
    };
  }, [playing]);

  const openLive = async (live: LiveChannelSource & { sourceName: string }) => {
    setLoading(true);
    setError('');
    setActiveName(live.name);
    try {
      const text = await fetchText(live.url);
      const ch = parseM3U(text);
      if (ch.length) {
        setChannels(ch);
        setActiveCat(ALL_CAT);
      } else setError('该直播地址解析为空，可能需代理或已失效');
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  };

  // 分类：从频道 group 去重，前置「推荐」
  const cats = useMemo(() => {
    if (!channels) return [ALL_CAT];
    const set = new Set<string>();
    for (const c of channels) if (c.group) set.add(c.group);
    return [ALL_CAT, ...Array.from(set)];
  }, [channels]);

  const visibleChannels = useMemo(() => {
    if (!channels) return [];
    if (activeCat === ALL_CAT) return channels;
    return channels.filter((c) => c.group === activeCat);
  }, [channels, activeCat]);

  return (
    <div className="view live">
      {/* 顶部标题栏：一级显示"直播"，二级显示"返回 + 直播频道" */}
      <div className="live-header">
        {channels ? (
          <div className="live-back tap" onClick={() => { setChannels(null); setActiveName(''); }}>
            <Icon name="arrow-left" size={20} />
            <span>返回直播源</span>
          </div>
        ) : (
          <div className="live-title">
            <Icon name="cast" size={20} />
            <span>直播</span>
          </div>
        )}
      </div>

      {channels ? (
        <>
          {/* 顶部播放器：去掉原生 controls，用自定义控制层 */}
          <div className="live-preview">
            {playing ? (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  className="live-video"
                  onClick={togglePlay}
                  onPlay={() => setPaused(false)}
                  onPause={() => setPaused(true)}
                />
                {playing && <div className="lp-name">{playing.name}</div>}
                <div className="lp-controls">
                  <button onClick={togglePlay}>
                    <Icon name={paused ? 'play' : 'pause'} size={18} />
                  </button>
                  <button onClick={toggleFullscreen}>
                    <Icon name="maximize" size={18} />
                  </button>
                </div>
              </>
            ) : (
              <div className="lp-empty">
                <Icon name="play" size={28} />
                <span>点击频道开始播放</span>
              </div>
            )}
          </div>

          {/* 主体：左分类 + 右频道网格 */}
          <div className="live-main">
            <div className="live-cats" role="tablist">
              {cats.map((cat) => (
                <div
                  key={cat}
                  className={'live-cat' + (activeCat === cat ? ' on' : '')}
                  onClick={() => setActiveCat(cat)}
                >
                  {cat}
                </div>
              ))}
            </div>

            <div className="live-grid">
              {visibleChannels.map((c, i) => (
                <div
                  key={i}
                  className="live-ch tap"
                  onClick={() => setPlaying({ url: c.url, name: c.name })}
                >
                  <div className="lc-logo">
                    {c.logo ? <img src={c.logo} alt="" /> : <span>{c.name.slice(0, 1)}</span>}
                  </div>
                  <div className="lc-info">
                    <div className="lc-name">{c.name}</div>
                    <div className="lc-prog">{c.group || activeName}</div>
                  </div>
                </div>
              ))}
              {visibleChannels.length === 0 && <div className="empty sm">该分类暂无频道</div>}
            </div>
          </div>
        </>
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
    </div>
  );
}
