import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Hls from 'hls.js';
import { invoke } from '@tauri-apps/api/core';
import { aggregateLives } from '../../engine';
import { SourceConfig, LiveChannelSource } from '../../engine/types';
import { Icon } from '../../components/Icon';

interface Channel {
  name: string;
  url: string;
  logo?: string;
  group?: string;
}

interface DlnaDevice {
  name: string;
  location: string;
  controlUrl: string;
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

// 解析 m3u / txt 直播列表；同名频道多个 URL 聚合为 sources[]（换源）
function parseM3U(text: string): { name: string; sources: string[]; logo?: string; group?: string }[] {
  const lines = text.split(/\r?\n/);
  const raw: Channel[] = [];
  let name = '';
  let logo = '';
  let group = '';
  for (const rawLine of lines) {
    const t = rawLine.trim();
    if (t.startsWith('#EXTINF')) {
      const logoMatch = t.match(/tvg-logo="([^"]*)"/i);
      logo = logoMatch ? logoMatch[1] : '';
      const groupMatch = t.match(/group-title="([^"]*)"/i);
      group = groupMatch ? groupMatch[1] : '';
      const idx = t.lastIndexOf(',');
      name = idx >= 0 ? t.slice(idx + 1).trim() : '';
    } else if (t && !t.startsWith('#')) {
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
        raw.push({ name: name || url, url, logo, group });
        name = '';
        logo = '';
        group = '';
      }
    }
  }
  // 同名聚合
  const map = new Map<string, { name: string; sources: string[]; logo?: string; group?: string }>();
  for (const c of raw) {
    const key = c.name;
    if (!map.has(key)) map.set(key, { name: c.name, sources: [], logo: c.logo, group: c.group });
    const entry = map.get(key)!;
    if (!entry.sources.includes(c.url)) entry.sources.push(c.url);
    if (!entry.logo && c.logo) entry.logo = c.logo;
    if (!entry.group && c.group) entry.group = c.group;
  }
  return Array.from(map.values());
}

const ALL_CAT = '推荐';

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

export function Live({ sources, onOpenSources, onDebug }: { sources: SourceConfig[]; onOpenSources: () => void; onDebug?: () => void }) {
  const [lives, setLives] = useState<(LiveChannelSource & { sourceName: string })[]>([]);
  const [channels, setChannels] = useState<ReturnType<typeof parseM3U> | null>(null);
  const [activeName, setActiveName] = useState('');
  const [activeSrc, setActiveSrc] = useState(1); // 当前换源序号（1-based）
  const [playing, setPlaying] = useState<{ url: string; name: string } | null>(null);
  const [activeCat, setActiveCat] = useState(ALL_CAT);
  const [loading, setLoading] = useState(false);
  const [livesLoading, setLivesLoading] = useState(false);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [srcSheet, setSrcSheet] = useState(false); // 横屏换源条
  const [pickSheet, setPickSheet] = useState(false); // 横屏选台浮层
  const videoRef = useRef<HTMLVideoElement>(null);

  // 当前频道对象（聚合后的）
  const curChannel = useMemo(() => channels?.find((c) => c.name === activeName) ?? null, [channels, activeName]);
  const curUrl = useMemo(() => {
    if (!curChannel) return playing?.url ?? '';
    return curChannel.sources[Math.min(activeSrc, curChannel.sources.length) - 1] ?? curChannel.sources[0];
  }, [curChannel, activeSrc, playing]);

  // 横屏方案：CSS 铺满视口 + 原生强制横屏（window.MuHaiAndroid.setOrientation）
  const toggleFullscreen = useCallback(() => {
    if (!isFullscreen) {
      setIsFullscreen(true);
      try { (window as any).MuHaiAndroid?.setOrientation?.('landscape'); } catch { /* ignore */ }
    } else {
      setIsFullscreen(false);
      try { (window as any).MuHaiAndroid?.setOrientation?.('portrait'); } catch { /* ignore */ }
    }
  }, [isFullscreen]);

  // 点击 video 或按钮切换播放/暂停
  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) { el.play().catch(() => {}); setPaused(false); }
    else { el.pause(); setPaused(true); }
  };

  // 横屏换台：可见频道里上/下一个
  const changeChannel = (dir: 1 | -1) => {
    if (!channels) return;
    const list = visibleChannels;
    const idx = list.findIndex((c) => c.name === activeName);
    const next = list[(idx + dir + list.length) % list.length];
    if (next) pickChannel(next.name);
  };

  const reloadLives = () => {
    if (!sources.length) {
      setLives([]);
      setChannels(null);
      setLivesLoading(false);
      return;
    }
    setError('');
    setLivesLoading(true);
    aggregateLives(sources, { force: true })
      .then((r) => {
        const flat = r.groups.flatMap((g) => g.channels.map((c) => ({ ...c, sourceName: g.sourceName })));
        setLives(flat);
        if (!flat.length) setError('未检测到可用直播源（需导入含 lives[] 的 tvbox 配置，如影视仓 XC.json）');
      })
      .catch(() => setError('直播源加载失败'))
      .finally(() => setLivesLoading(false));
  };

  useEffect(() => {
    reloadLives();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  // 播放当前 curUrl（切台/换源/初播都走这里）
  useEffect(() => {
    if (!curUrl || !videoRef.current) return;
    const el = videoRef.current;
    const isHls = /\.m3u8(\?|$)/i.test(curUrl);
    let hls: Hls | null = null;
    if (isHls && el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = curUrl;
    } else if (isHls && Hls.isSupported()) {
      hls = new Hls({ xhrSetup: (xhr, u) => { for (const [k, v] of Object.entries(streamHeaders(u))) xhr.setRequestHeader(k, v); } });
      hls.loadSource(curUrl);
      hls.attachMedia(el);
    } else {
      el.src = curUrl;
    }
    return () => {
      if (hls) hls.destroy();
      el.removeAttribute('src');
      el.load();
    };
  }, [curUrl]);

  const openLive = async (live: LiveChannelSource & { sourceName: string }) => {
    setLoading(true);
    setError('');
    try {
      const text = await fetchText(live.url);
      const ch = parseM3U(text);
      if (ch.length) {
        setChannels(ch);
        setActiveCat(ALL_CAT);
        setActiveName(ch[0].name);
        setActiveSrc(1);
      } else setError('该直播地址解析为空，可能需代理或已失效');
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  };

  // 选频道：只切 activeName（驱动 curUrl 派生），不重绘列表，避免画面闪动
  const pickChannel = (name: string) => {
    setActiveName(name);
    setActiveSrc(1);
    setPlaying({ url: '', name }); // 标记播放态，url 由 curUrl 派生
    setPickSheet(false);
  };

  // 换源：只切 activeSrc
  const pickSrc = (idx: number) => {
    setActiveSrc(idx);
    setPlaying({ url: '', name: activeName });
    setSrcSheet(false);
  };

  // 分类：去重 + 推荐前置
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

  // 逐级返回：频道列表态（channels 不为 null）先退源列表；否则放行外层
  useEffect(() => {
    const prev = (window as any).__onAndroidBack;
    (window as any).__onAndroidBack = () => {
      if (isFullscreen) { toggleFullscreen(); return false; }
      if (pickSheet) { setPickSheet(false); return false; }
      if (srcSheet) { setSrcSheet(false); return false; }
      if (channels) { setChannels(null); setActiveName(''); setPlaying(null); return false; }
      return prev ? !!prev() : true;
    };
    return () => { (window as any).__onAndroidBack = prev; };
  }, [channels, isFullscreen, pickSheet, srcSheet, toggleFullscreen]);

  return (
    <div className={'view live' + (isFullscreen ? ' lp-fullscreen' : '')}>
      {/* 一级：直播源列表 */}
      {!channels ? (
        livesLoading ? (
          <div className="blank-state">
            <div className="blank-art"><Icon name="cast" size={44} /></div>
            <h2>正在加载直播源…</h2>
            <p className="muted">正在从你导入的 tvbox 配置拉取直播线路，请稍候。</p>
          </div>
        ) : lives.length ? (
          <div className="live-list">
            <div className="live-list-head">
              <Icon name="cast" size={20} />
              <span>直播源</span>
            </div>
            {lives.map((l, i) => (
              <div key={i} className="settings-row tap" onClick={() => openLive(l)}>
                <span className="ico"><Icon name="cast" size={20} /></span>
                <span className="label">{l.name}</span>
                <span className="value muted">{l.sourceName}</span>
                <span className="chevron"><Icon name="arrow-right" size={18} /></span>
              </div>
            ))}
          </div>
        ) : (
          <div className="blank-state">
            <div className="blank-art"><Icon name="cast" size={44} /></div>
            <h2>{error || '直播源未配置'}</h2>
            <p className="muted">直播线路来自你导入的 tvbox 配置中的 lives[]。<br />导入含直播线路的源后，这里即可观看。</p>
            <button className="primary" onClick={onOpenSources}>去源管理添加</button>
          </div>
        )
      ) : (
        /* 二级：选台 + 播放 */
        <div className="live-room">
          {/* 顶栏 + 小窗 合并为同一卡片块 */}
          <div className="lp-head-stage">
            <div className="lp-hd">
              <button className="lp-back" onClick={() => { setChannels(null); setActiveName(''); setPlaying(null); }}>
                <Icon name="arrow-left" size={18} />
              </button>
              <div className="lp-title">
                <span className="lp-ch-name">{activeName || '未播放'}</span>
                {curChannel && curChannel.sources.length > 1 && (
                  <span className="lp-res">源 {activeSrc}/{curChannel.sources.length}</span>
                )}
              </div>
              <button className="lp-tv" onClick={onDebug} title="调试">
                <Icon name="bug" size={18} />
              </button>
            </div>
            <div className="lp-stage">
              {playing ? (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  className="live-video"
                  onClick={togglePlay}
                  onPlay={() => setPaused(false)}
                  onPause={() => setPaused(true)}
                />
              ) : (
                <div className="lp-empty">
                  <Icon name="play" size={28} />
                  <span>点击频道开始播放</span>
                </div>
              )}
              {playing && (
                <button className="lp-big" onClick={togglePlay} title={paused ? '播放' : '暂停'}>
                  <Icon name={paused ? 'play' : 'pause'} size={28} />
                </button>
              )}
              <button className="lp-rotate" onClick={toggleFullscreen} title="横屏">
                <Icon name="rotate" size={18} />
              </button>
            </div>
          </div>

          {/* 两栏选台 */}
          <div className="lp-pick">
            <div className="lp-cats" role="tablist">
              {cats.map((cat) => (
                <div
                  key={cat}
                  className={'cat' + (activeCat === cat ? ' on' : '')}
                  onClick={() => setActiveCat(cat)}
                >
                  {cat}
                </div>
              ))}
            </div>
            <div className="lp-chs">
              {visibleChannels.map((c) => (
                <div
                  key={c.name}
                  data-name={c.name}
                  className={'ch' + (c.name === activeName ? ' on' : '')}
                  onClick={() => pickChannel(c.name)}
                >
                  <span className="ch-dot" />
                  <div className="ch-body">
                    <div className="ch-name">{c.name}</div>
                    {c.sources.length > 1 && <div className="ch-src-hint">源 {c.sources.length} 个</div>}
                  </div>
                </div>
              ))}
              {visibleChannels.length === 0 && <div className="empty sm">该分类暂无频道</div>}
            </div>
          </div>
        </div>
      )}

      {loading && <div className="empty sm">正在加载直播频道…</div>}

      {/* 横屏浮层：选台 + 换源条 + 底部控制 */}
      {isFullscreen && channels && (
        <div className="land-overlay">
          <div className="land-top">
            <button className="land-back" onClick={toggleFullscreen}>
              <Icon name="arrow-left" size={18} />
            </button>
            <div className="land-title">
              <span>{activeName}</span>
              {curChannel && curChannel.sources.length > 1 && <span className="lp-res">源 {activeSrc}/{curChannel.sources.length}</span>}
            </div>
            <button className="land-tv" onClick={onDebug} title="调试">
              <Icon name="bug" size={18} />
            </button>
          </div>
          <div className="land-center">
            <button onClick={() => changeChannel(-1)} title="上一个"><Icon name="skip-back" size={26} /></button>
            <button className="main" onClick={togglePlay} title={paused ? '播放' : '暂停'}>
              <Icon name={paused ? 'play' : 'pause'} size={32} />
            </button>
            <button onClick={() => changeChannel(1)} title="下一个"><Icon name="skip-fwd" size={26} /></button>
          </div>
          <div className="land-bottom">
            <button className={'land-src' + (srcSheet ? ' on' : '')} onClick={() => setSrcSheet((s) => !s)} title="换源">
              源{activeSrc}
            </button>
            <button className="land-pbtn" onClick={togglePlay} title={paused ? '播放' : '暂停'}>
              <Icon name={paused ? 'play' : 'pause'} size={18} />
            </button>
            <button className={'land-list' + (pickSheet ? ' on' : '')} onClick={() => setPickSheet((s) => !s)} title="选台">
              <Icon name="list" size={18} />
            </button>
          </div>

          {/* 横屏选台浮层 */}
          {pickSheet && (
            <div className="land-pick">
              <div className="lp-cats">
                {cats.map((cat) => (
                  <div key={cat} className={'cat' + (activeCat === cat ? ' on' : '')} onClick={() => setActiveCat(cat)}>{cat}</div>
                ))}
              </div>
              <div className="lp-chs">
                {visibleChannels.map((c) => (
                  <div key={c.name} data-name={c.name} className={'ch' + (c.name === activeName ? ' on' : '')} onClick={() => pickChannel(c.name)}>
                    <span className="ch-dot" />
                    <div className="ch-body">
                      <div className="ch-name">{c.name}</div>
                      {c.sources.length > 1 && <div className="ch-src-hint">源 {c.sources.length} 个</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 横屏换源条 */}
          {srcSheet && curChannel && (
            <div className="land-srcbar">
              <span className="land-srcbar-label">切换源</span>
              <div className="land-srcbar-row">
                {curChannel.sources.map((_, i) => (
                  <div key={i} className={'src' + (i + 1 === activeSrc ? ' on' : '')} onClick={() => pickSrc(i + 1)}>
                    源{i + 1}
                  </div>
                ))}
              </div>
              <button className="land-srcbar-close" onClick={() => setSrcSheet(false)}>
                <Icon name="x" size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
