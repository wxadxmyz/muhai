// TV 直播页（清单左竖导航「直播」）：源列表 → 分类筛选 → 频道网格 → HLS 播放。
// 复用 aggregateLives 拉取直播源，复用 hlsPlayer 后端代理播放；遥控器方向键在频道间移动、OK 切换/播放。
// 与手机端 Live.tsx 的差异：去掉触摸手势/锁屏/画中画等遥控器无概念的交互，改为全 DPAD 操作。
import { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { aggregateLives, SourceConfig, LiveChannelSource } from '../../engine';
import { createBackendLoader, streamHeaders, peekIsHls } from '../../lib/hlsPlayer';
import { Icon } from '../../components/Icon';
import { toast } from '../../lib/toast';
import { focusElement, isTvConfirmKey } from '../../lib/focusNav';
import { pushBackHandler } from '../../lib/backStack';

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
  // V4.5.8 #3：全屏画面加载态——true 时用纯黑+转圈盖住原生播放占位三角，video 真正出帧后再揭开。
  const [stageLoading, setStageLoading] = useState(true);
  const [cat, setCat] = useState(ALL_CAT);
  const videoRef = useRef<HTMLVideoElement>(null);
  const headersRef = useRef<Record<string, string> | null>(null);
  // V4.5.7 #20：影视仓式全屏直播 + 左侧浮窗面板
  const [panelOpen, setPanelOpen] = useState(false); // 左侧分类/频道浮窗是否展开
  const [enterCat, setEnterCat] = useState(ALL_CAT); // 从哪个分类进的频道列表，频道左键回位（搜索页式记忆）
  const enteredSrcRef = useRef<HTMLElement | null>(null); // 点进去的源列表项，退出时还原光标
  const enteredSrcIndexRef = useRef<number>(-1); // V4.5.8 #6：源列表在退出后会重建，节点引用失效，按索引重新定位
  const curChannelRef = useRef<Channel | null>(null); // 当前频道（供键盘监听读取最新值）
  const activeNameRef = useRef('');
  const activeSrcRef = useRef(1);
  const playingRef = useRef(false);
  const catRef = useRef(ALL_CAT);
  const panelOpenRef = useRef(false);
  // 同步 ref 镜像，供 window 捕获监听（闭包只建一次）读取最新状态
  curChannelRef.current = channels?.find((c) => c.name === activeName) ?? null;
  activeNameRef.current = activeName;
  activeSrcRef.current = activeSrc;
  playingRef.current = playing;
  catRef.current = cat;
  panelOpenRef.current = panelOpen;

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

  const openLive = async (live: LiveChannelSource & { sourceName: string }, srcEl?: HTMLElement, srcIndex?: number) => {
    setError('');
    setChannels(null);
    // V4.5.7 #20 / V4.5.8 #6：记住点进去的源项与索引，退出时还原光标
    if (srcEl) enteredSrcRef.current = srcEl;
    if (typeof srcIndex === 'number') enteredSrcIndexRef.current = srcIndex;
    try {
      const text = await (async () => {
        try { return await (await import('@tauri-apps/api/core')).invoke<string>('fetchsource', { url: live.url }); }
        catch { const res = await fetch(live.url, { redirect: 'follow' }); if (!res.ok) throw new Error('HTTP ' + res.status); return await res.text(); }
      })();
      const ch = parseM3U(text);
      if (!ch.length) { setError('该直播地址解析为空'); return; }
      // V4.5.7 #20：点源即进影视仓式全屏直播（不再先停在频道列表）
      setChannels(ch); setCat(ALL_CAT); setActiveName(ch[0].name); setActiveSrc(1);
      headersRef.current = ch[0].headers ?? null;
      setStageLoading(true); // V4.5.8 #3：进全屏先黑屏加载
      setPlaying(true);
    } catch (e: any) { setError(e?.message ?? '加载失败'); }
  };

  const pick = (name: string, ch?: Channel) => {
    const c = ch ?? channels?.find((x) => x.name === name);
    if (!c) return;
    headersRef.current = c.headers ?? null;
    setStageLoading(true); // V4.5.8 #3：选台先黑屏加载
    setActiveName(name); setActiveSrc(1); setPlaying(true);
  };

  const curChannel = channels?.find((c) => c.name === activeName) ?? null;
  const curUrl = useMemo(() => {
    if (!curChannel) return '';
    return curChannel.sources[Math.min(activeSrc, curChannel.sources.length) - 1] ?? curChannel.sources[0];
  }, [curChannel, activeSrc]);

  // V4.5.7 #20：全屏时换台（上下）/换线路（左右）
  const stepChannel = (delta: number) => {
    const list = channels ?? [];
    if (!list.length) return;
    const cur = list.findIndex((c) => c.name === activeNameRef.current);
    const next = ((cur < 0 ? 0 : cur + delta) + list.length) % list.length;
    const c = list[next];
    headersRef.current = c.headers ?? null;
    setStageLoading(true); // V4.5.8 #3：换台先黑屏加载
    setActiveName(c.name);
    setActiveSrc(1);
    setCat(c.group && cats.includes(c.group) ? c.group : ALL_CAT);
  };
  const stepSource = (delta: number) => {
    const c = curChannelRef.current;
    if (!c || c.sources.length <= 1) return; // 单线路左右键不动
    const next = ((activeSrcRef.current - 1 + delta) + c.sources.length) % c.sources.length + 1;
    setStageLoading(true); // V4.5.8 #3：换线路先黑屏加载
    setActiveSrc(next);
  };
  const exitLive = () => {
    setPanelOpen(false);
    setPlaying(false);
    setChannels(null);
    setCat(ALL_CAT);
    // V4.5.8 #6：退出回源列表，光标落到点进去的那一项。
    // 源列表在 playing=false 后重建，旧节点引用已 isConnected=false，故按索引重新定位。
    window.setTimeout(() => {
      let el: HTMLElement | null = null;
      const idx = enteredSrcIndexRef.current;
      if (idx >= 0) {
        const nodes = document.querySelectorAll<HTMLElement>('.tv-live-src');
        el = nodes[idx] ?? null;
      }
      if (!el || !el.isConnected) el = enteredSrcRef.current;
      if (el && el.isConnected) focusElement(el);
    }, 100);
  };

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

  // V4.5.7 #20：全屏画面时的遥控器接管（window 捕获，早于全局焦点导航）。
  //  - 面板关闭：OK 弹面板；上下换台；左右换线路（单线路不动）。拦截事件不让焦点导航/快捷键再处理。
  //  - 面板打开：方向键/OK 全部交给焦点导航在浮窗内移动，不做换台换源。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!playingRef.current) return; // 非全屏播放态完全不接管
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (panelOpenRef.current) return; // 面板内交给焦点导航
      if (isTvConfirmKey(e)) {
        e.preventDefault(); e.stopPropagation();
        setPanelOpen(true);
        return;
      }
      const k = e.key;
      if (k === 'ArrowUp' || k === 'Up') { e.preventDefault(); e.stopPropagation(); stepChannel(-1); }
      else if (k === 'ArrowDown' || k === 'Down') { e.preventDefault(); e.stopPropagation(); stepChannel(1); }
      else if (k === 'ArrowLeft' || k === 'Left') { e.preventDefault(); e.stopPropagation(); stepSource(-1); }
      else if (k === 'ArrowRight' || k === 'Right') { e.preventDefault(); e.stopPropagation(); stepSource(1); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels]);

  // V4.5.7 #20：全屏播放态的返回键——面板开着先关面板，否则退出回源列表
  useEffect(() => pushBackHandler(() => {
    if (!playingRef.current) return false;
    if (panelOpenRef.current) { setPanelOpen(false); return true; }
    exitLive();
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  if (channels && playing) {
    return (
      <div className="tv-live-stage">
        {/* V4.5.7 #20：全屏画面铺底（盖住外壳顶栏），OK 弹左侧主题色浮窗 */}
        {/* V4.5.8 #3：原生 video 在 WebView 会露出中央播放占位三角，故始终用黑底承载；
            playing/loadeddata 真正出帧后才揭开转圈遮罩，避免「先播放三角、后黑屏」的错位观感。 */}
        <video
          ref={videoRef} autoPlay playsInline className="tv-live-fullvideo"
          onPlaying={() => setStageLoading(false)}
          onLoadedData={() => setStageLoading(false)}
        />
        {stageLoading && (
          <div className="tv-live-stage-loading">
            <span className="vp-spinner" />
            <span className="tvp-loading-text">加载中…</span>
          </div>
        )}
        <div className="tv-live-stage-name">{activeName}</div>
        {/* V4.5.10 #7：删除大屏底部居中的当前频道文字框（顶部已有 tv-live-stage-name） */}
        <div className="tv-live-stage-help">OK 选台 · ↑↓ 换台 · ←→ 换线路 · 返回退出</div>
        {panelOpen && (
          <div className="tv-live-panel" data-focus-root>
            <div className="tv-live-panel-inner">
              <div className="tv-live-cats">
                {cats.map((c) => (
                  <div
                    key={c}
                    id={`live-cat-${cats.indexOf(c)}`}
                    className={'tv-cat' + (cat === c ? ' active' : '')}
                    data-focusable=""
                    data-nav-right=".tv-live-panel .tv-live-chs .tv-live-ch"
                    onFocus={() => { setCat(c); setEnterCat(c); }}
                    onClick={() => { setCat(c); setEnterCat(c); }}
                    role="button"
                  >{c}</div>
                ))}
              </div>
              <div className="tv-live-chs">
                {visible.map((c) => (
                  <div
                    key={c.name}
                    className={'tv-live-ch' + (c.name === activeName ? ' on' : '')}
                    data-focusable=""
                    // 当前频道设为面板打开后的初始焦点；左键回到进来的分类
                    data-autofocus={c.name === activeName ? '' : undefined}
                    data-nav-left={`#live-cat-${Math.max(0, cats.indexOf(enterCat))}`}
                    onFocus={() => { if (c.group && cats.includes(c.group) && c.group !== cat) setCat(c.group); }}
                    onClick={() => { pick(c.name, c); setPanelOpen(false); }}
                    role="button"
                  >
                    {/* V4.5.10 #3：影视仓式频道数字序号 */}
                    <span className="tv-live-ch-no">{String(visible.indexOf(c) + 1).padStart(2, '0')}</span>
                    <span className="tv-live-ch-name">{c.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (channels && !playing) {
    return (
      <div className="tv-live-body tv-flush-top">
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
    <div className="tv-live-list tv-flush-top">
      {/* V4.5.8 #6：点击源时把元素与索引传给 openLive 记录，退出直播据此还原光标到点进去的源。 */}
      {lives.map((l, i) => (
        <div key={i} className="tv-live-src" data-focusable="" onClick={(e) => openLive(l, e.currentTarget, i)} role="button">
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
