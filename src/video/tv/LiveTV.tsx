// TV 直播页（清单左竖导航「直播」）：源列表 → 分类筛选 → 频道网格 → HLS 播放。
// 复用 aggregateLives 拉取直播源，复用 hlsPlayer 后端代理播放；遥控器方向键在频道间移动、OK 切换/播放。
// 与手机端 Live.tsx 的差异：去掉触摸手势/锁屏/画中画等遥控器无概念的交互，改为全 DPAD 操作。
import { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { aggregateLives, SourceConfig, LiveChannelSource } from '../../engine';
import { createBackendLoader, streamHeaders, peekIsHls } from '../../lib/hlsPlayer';
import { Icon } from '../../components/Icon';
import { toast } from '../../lib/toast';

interface Channel { name: string; sources: string[]; group?: string; headers?: Record<string, string>; }

function parseM3U(text: string): Channel[] {
  const lines = text.split(/\r?\n/);
  const raw: { name: string; url: string; group?: string; headers?: Record<string, string> }[] = [];
  let name = '', group = '', logo = '', curHeaders: Record<string, string> | undefined;
  for (const t of lines) {
    const s = t.trim();
    if (s.startsWith('#EXTINF')) {
      const gm = s.match(/group-title="([^"]*)"/i);
      group = gm ? gm[1] : '';
      const ua = s.match(/http-user-agent="([^"]*)"/i) || s.match(/user-agent="([^"]*)"/i);
      const rf = s.match(/http-referer="([^"]*)"/i) || s.match(/http-referrer="([^"]*)"/i);
      const og = s.match(/http-origin="([^"]*)"/i);
      const hd: Record<string, string> = {};
      if (ua) hd['User-Agent'] = ua[1];
      if (rf) hd['Referer'] = rf[1];
      if (og) hd['Origin'] = og[1];
      curHeaders = Object.keys(hd).length ? hd : undefined;
      const idx = s.lastIndexOf(',');
      name = idx >= 0 ? s.slice(idx + 1).trim() : '';
    } else if (s && !s.startsWith('#')) {
      let url = /^https?:\/\//.test(s) ? s : (s.match(/,\s*(https?:\/\/\S+)\s*$/)?.[1] ?? '');
      if (url) { raw.push({ name: name || url, url, group, headers: curHeaders }); name = ''; group = ''; curHeaders = undefined; }
    }
  }
  const map = new Map<string, Channel>();
  for (const c of raw) {
    if (!map.has(c.name)) map.set(c.name, { name: c.name, sources: [], group: c.group, headers: c.headers });
    const e = map.get(c.name)!;
    if (!e.sources.includes(c.url)) e.sources.push(c.url);
    if (!e.group && c.group) e.group = c.group;
    if (!e.headers && c.headers) e.headers = c.headers;
  }
  return Array.from(map.values());
}

const ALL_CAT = '推荐';

export function LiveTV({ sources }: { sources: SourceConfig[] }) {
  const [lives, setLives] = useState<(LiveChannelSource & { sourceName: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [activeName, setActiveName] = useState('');
  const [activeSrc, setActiveSrc] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [cat, setCat] = useState(ALL_CAT);
  const videoRef = useRef<HTMLVideoElement>(null);
  const headersRef = useRef<Record<string, string> | null>(null);

  useEffect(() => {
    setLoading(true);
    aggregateLives(sources, { force: true })
      .then((r) => {
        const flat = r.groups.flatMap((g) => g.channels.map((c) => ({ ...c, sourceName: g.sourceName })));
        setLives(flat);
        if (!flat.length) setError('未检测到可用直播源（需导入含 lives[] 的 tvbox 配置）');
      })
      .catch(() => setError('直播源加载失败'))
      .finally(() => setLoading(false));
  }, [sources]);

  const cats = useMemo(() => {
    if (!channels) return [ALL_CAT];
    const set = new Set<string>();
    channels.forEach((c) => c.group && set.add(c.group));
    return [ALL_CAT, ...Array.from(set)];
  }, [channels]);
  const visible = useMemo(() => !channels ? [] : cat === ALL_CAT ? channels : channels.filter((c) => c.group === cat), [channels, cat]);

  const openLive = async (live: LiveChannelSource & { sourceName: string }) => {
    setError('');
    setChannels(null);
    try {
      const text = await (async () => {
        try { return await (await import('@tauri-apps/api/core')).invoke<string>('fetchsource', { url: live.url }); }
        catch { const res = await fetch(live.url, { redirect: 'follow' }); if (!res.ok) throw new Error('HTTP ' + res.status); return await res.text(); }
      })();
      const ch = parseM3U(text);
      if (!ch.length) { setError('该直播地址解析为空'); return; }
      setChannels(ch); setCat(ALL_CAT); setActiveName(ch[0].name); setActiveSrc(1); headersRef.current = ch[0].headers ?? null;
    } catch (e: any) { setError(e?.message ?? '加载失败'); }
  };

  const pick = (name: string, ch?: Channel) => {
    const c = ch ?? channels?.find((x) => x.name === name);
    if (!c) return;
    headersRef.current = c.headers ?? null;
    setActiveName(name); setActiveSrc(1); setPlaying(true);
  };

  const curChannel = channels?.find((c) => c.name === activeName) ?? null;
  const curUrl = useMemo(() => {
    if (!curChannel) return '';
    return curChannel.sources[Math.min(activeSrc, curChannel.sources.length) - 1] ?? curChannel.sources[0];
  }, [curChannel, activeSrc]);

  useEffect(() => {
    if (!curUrl || !playing || !videoRef.current) return;
    const el = videoRef.current;
    let hls: Hls | null = null; let cancelled = false;
    const headers = headersRef.current;
    const prefersBackend = !!headers;
    const suffixHls = /\.m3u8(\?|$)/i.test(curUrl);
    const attach = (backend: boolean) => {
      if (cancelled || !videoRef.current) return;
      const v = videoRef.current;
      if (!Hls.isSupported()) { v.src = curUrl; return; }
      const loader = backend ? createBackendLoader(headers) : undefined;
      hls = new Hls(loader ? { loader, pLoader: loader } : {
        xhrSetup: (xhr, u) => { for (const [k, val] of Object.entries(streamHeaders(u, headers))) xhr.setRequestHeader(k, val); },
      });
      hls.loadSource(curUrl); hls.attachMedia(v);
      hls.on(Hls.Events.ERROR, (_e, d: any) => {
        if (d.fatal) toast('直播播放失败：' + (d.details || d.type));
      });
    };
    if (el.canPlayType('application/vnd.apple.mpegurl') && !prefersBackend) el.src = curUrl;
    else if (prefersBackend) { if (Hls.isSupported()) attach(true); else el.src = curUrl; }
    else if (suffixHls) { if (Hls.isSupported()) attach(false); else el.src = curUrl; }
    else peekIsHls(curUrl, headers).then((isH) => { if (cancelled) return; if (isH && Hls.isSupported()) attach(true); else el.src = curUrl; }).catch(() => { if (!cancelled) el.src = curUrl; });
    return () => { cancelled = true; if (hls) hls.destroy(); el.removeAttribute('src'); el.load(); };
  }, [curUrl, playing]);

  if (channels && playing) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ position: 'relative', flex: '1 1 auto', background: '#000', borderRadius: 12, overflow: 'hidden' }}>
          <video ref={videoRef} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          <div style={{ position: 'absolute', top: 14, left: 16, fontSize: 20, fontWeight: 700, textShadow: '0 2px 6px #000' }}>{activeName}</div>
          <button className="tv-action-btn" data-focusable="" style={{ position: 'absolute', top: 12, right: 12 }} onClick={() => { setPlaying(false); setChannels(null); setActiveName(''); }}>
            <Icon name="x" size={18} /> 退出
          </button>
          <button className="tv-action-btn" data-focusable="" style={{ position: 'absolute', bottom: 14, right: 14 }} onClick={() => setPlaying(false)}>
            <Icon name="list" size={18} /> 选台
          </button>
        </div>
        <div style={{ height: 200, marginTop: 14, display: 'flex', gap: 16 }}>
          <div className="tv-live-cats">
            {cats.map((c) => (
              <div key={c} className={'tv-cat' + (cat === c ? ' active' : '')} data-focusable="" onClick={() => setCat(c)} role="button">{c}</div>
            ))}
          </div>
          <div className="tv-live-chs">
            {visible.map((c) => (
              <div key={c.name} className={'tv-live-ch' + (c.name === activeName ? ' on' : '')} data-focusable="" onClick={() => pick(c.name, c)} role="button">
                {c.name}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (channels && !playing) {
    return (
      <div className="tv-live-body">
        <div className="tv-live-cats">
          {cats.map((c) => (
            <div key={c} className={'tv-cat' + (cat === c ? ' active' : '')} data-focusable="" onClick={() => setCat(c)} role="button">{c}</div>
          ))}
        </div>
        <div className="tv-live-chs">
          {visible.map((c) => (
            <div key={c.name} className={'tv-live-ch' + (c.name === activeName ? ' on' : '')} data-focusable="" onClick={() => pick(c.name, c)} role="button">
              {c.name}
            </div>
          ))}
          {visible.length === 0 && <div className="tv-empty">该分类暂无频道</div>}
        </div>
      </div>
    );
  }

  if (loading) return <div className="tv-empty">正在加载直播源…</div>;
  if (error && !lives.length) {
    return (
      <div className="tv-empty">
        {error}
        <div style={{ marginTop: 12, fontSize: 15 }}>去「设置 → 添加源」导入含 lives[] 的 tvbox 配置</div>
      </div>
    );
  }
  return (
    <div className="tv-live-list">
      {lives.map((l, i) => (
        <div key={i} className="tv-live-src" data-focusable="" onClick={() => openLive(l)} role="button">
          <Icon name="tv" size={22} />
          <div>
            <div>{l.name}</div>
            <div className="sm">lives[] · {l.sourceName}</div>
          </div>
        </div>
      ))}
      {lives.length === 0 && <div className="tv-empty">{error || '直播源未配置'}</div>}
    </div>
  );
}
