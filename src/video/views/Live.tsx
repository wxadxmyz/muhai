import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Hls from 'hls.js';
import { invoke } from '@tauri-apps/api/core';
import { aggregateLives } from '../../engine';
import { SourceConfig, LiveChannelSource } from '../../engine/types';
import { Icon } from '../../components/Icon';
import { CastOverlay } from '../../components/CastOverlay';
import { toast } from '../../lib/toast';
import { requestOrientation, requestImmersive } from '../../lib/orientation';

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

export function Live({ sources, onOpenSources }: { sources: SourceConfig[]; onOpenSources: () => void }) {
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
  const [showCast, setShowCast] = useState(false); // 真实 DLNA 投屏浮层
  const [landControls, setLandControls] = useState(true); // 横屏控件显隐（自动隐藏）
  // 横屏锁屏：隐藏其余控件、禁手势、仅留锁按钮
  // B5 约束：锁定 / 解锁全程不得调用 pause() —— 锁屏只锁操作，不打断播放。
  const [locked, setLocked] = useState(false);
  // v3.1.1：小锁独立显隐（不再随整层 .hide 一起消失，解决"点一下锁就没了点不回来"）
  const [lockHidden, setLockHidden] = useState(false);
  const lockTimer = useRef<number | undefined>(undefined);
  const landHideTimer = useRef<number | undefined>(undefined);
  const landClickTimer = useRef<number | undefined>(undefined);
  // K2：清掉可能残留的单击/双击定时器。
  // 场景 —— 先点一下空白（起了 280ms 定时器），紧接着点返回/投屏/小锁：
  // 按钮动作已经执行完（比如退出了横屏），迟到的定时器才到点，又把控件状态翻一次，
  // 表现就是"控件莫名其妙自己藏起来"。所有控件按钮的 onClick 都会先调它。
  const clearTapTimer = useCallback(() => {
    if (landClickTimer.current) { window.clearTimeout(landClickTimer.current); landClickTimer.current = undefined; }
  }, []);
  const videoRef = useRef<HTMLVideoElement>(null);
  // 真实分辨率药丸（设计文件 [1920×1080]）+ 亮度/音量手势状态
  const [resolution, setResolution] = useState('1920×1080');
  const [brightness, setBrightness] = useState(1);
  const brightnessRef = useRef(1);
  const [hud, setHud] = useState<{ type: 'bright' | 'vol'; value: number } | null>(null);
  const hudTimer = useRef<number | undefined>(undefined);

  // 当前频道对象（聚合后的）
  const curChannel = useMemo(() => channels?.find((c) => c.name === activeName) ?? null, [channels, activeName]);
  const curUrl = useMemo(() => {
    if (!curChannel) return playing?.url ?? '';
    return curChannel.sources[Math.min(activeSrc, curChannel.sources.length) - 1] ?? curChannel.sources[0];
  }, [curChannel, activeSrc, playing]);

  // 横屏方案：CSS 铺满视口 + 原生强制横屏（window.MuHaiAndroid.setOrientation）
  // 单击切换控件显隐；播放态 3s 自动隐藏；锁屏强制常显（满足"单击显隐 / 双击暂停 / 自动隐藏"）
  const scheduleLandHide = useCallback(() => {
    if (landHideTimer.current) window.clearTimeout(landHideTimer.current);
    if (paused) return;
    // v3.1.1：锁定态 3 秒后只隐藏「小锁」（lockHidden），整层 landControls 维持 true（其余控件已由 .locked CSS 隐藏），
    //           这样锁不再随整层 .hide 一起消失，解决"点一下锁就没了点不回来"
    if (locked) { landHideTimer.current = window.setTimeout(() => setLockHidden(true), 3000); return; }
    landHideTimer.current = window.setTimeout(() => setLandControls(false), 3000);
  }, [paused, locked]);
  const showLandControls = useCallback(() => {
    setLandControls(true);
    scheduleLandHide();
  }, [scheduleLandHide]);

  // 进入横屏 / 播放 / 锁定 / 解锁后：控件出现，播放态 3s 后自动隐藏（竖屏也复用此逻辑）
  // B7+B9：锁定态也要走这里 —— 锁定瞬间先让小锁亮起，3 秒后由 scheduleLandHide 把它藏掉；
  //        解锁时同理，控件立刻出现并启动 3 秒倒计时。
  useEffect(() => {
    showLandControls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen, paused, locked, playing]);

  // ② 原生画中画状态回调：进入时隐藏控件；退出小窗回到横屏（小窗全屏钮语义）
  useEffect(() => {
    (window as any).__onPipChanged = (entered: boolean) => {
      if (entered) { setLandControls(false); setLocked(false); }
      else if (!isFullscreen) { setIsFullscreen(true); requestOrientation('landscape'); requestImmersive(true); }
    };
    return () => { (window as any).__onPipChanged = undefined; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen]);

  const toggleFullscreen = useCallback(() => {
    if (!isFullscreen) {
      setIsFullscreen(true);
      setLocked(false);
      showLandControls();
      // 安卓原生真旋转（X1：桥未就绪时自动等待，避免"有时不横"）；未注入则前端 CSS 铺满
      requestOrientation('landscape');
      requestImmersive(true);
    } else {
      setIsFullscreen(false);
      setLocked(false);
      // 退出横屏强制回竖屏（portrait）：避免用户关了系统「自动旋转」时卡在横屏回不来；视频继续播，不暂停
      requestOrientation('portrait');
      requestImmersive(false);
    }
  }, [isFullscreen, showLandControls]);

  // 点击 video 或按钮切换播放/暂停
  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) { el.play().catch(() => {}); setPaused(false); }
    else { el.pause(); setPaused(true); }
  };
  // V5/V6：删除了原先绑在 <video onClick> 的第二套定时器（onLiveStageClick + liveClickTimer）。
  // 之前它与 stage 的 onTouchEnd(landClickTimer) 各自独立计数，点一下会同时触发两套逻辑，
  // 导致单击被误判成双击、双击被吞掉。现在统一只走 onStageTouchEnd 一套分发：
  // 单击 = 控件显隐，双击 = 播放/暂停。

  // 投屏：打开真实 DLNA 设备列表（后端 dlnascan/castvideo），把当前频道 URL 推送到电视
  const handleCast = () => {
    if (!curUrl) { toast('当前没有可投屏的直播地址'); return; }
    setShowCast(true);
  };
  // 锁屏（直播）：B 组 8 条模型
  // 锁定 = 仅留小锁（其余由 .locked CSS 隐藏）、禁手势、视频继续播；小锁 3 秒后自动隐藏；
  // 锁定态单击只切小锁显隐（onStageTouchEnd 处理）；点锁本身 = 解锁并恢复全部、3 秒后自动隐藏。
  // 锁定全程不得调用 pause() —— 锁屏只锁操作，不打断播放。
  const toggleLock = () => {
    const next = !locked;
    setLocked(next);
    // ④ 锁定/解锁给出明确 toast 反馈，避免「点了像没反应」
    toast(next ? '已锁定屏幕（点小锁可解锁）' : '已解锁');
    if (lockTimer.current) { window.clearTimeout(lockTimer.current); lockTimer.current = undefined; }
    if (next) {
      setLandControls(true); // 锁定态保持整层可见（小锁在 .locked 下始终可点），不被 3 秒隐藏整层
      setLockHidden(false);
      lockTimer.current = window.setTimeout(() => setLockHidden(true), 3000);
    } else {
      setLockHidden(false);
      setLandControls(true); // 解锁恢复全部控件
      scheduleLandHide();    // 3 秒后自动隐藏
    }
  };

  // 画中画（② 原生系统级：点按钮即退出 App、桌面浮 16:9 小窗）
  const handlePip = () => {
    try {
      const m = (window as any).MuHaiAndroid;
      if (m && typeof m.enterPip === 'function') { m.enterPip(); return; }
      const el = videoRef.current;
      if (el && !document.pictureInPictureElement) el.requestPictureInPicture?.().catch(() => {});
    } catch { /* 不支持时静默 */ }
  };
  const showHud = (type: 'bright' | 'vol', value: number) => {
    setHud({ type, value });
    if (hudTimer.current) window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setHud(null), 800);
  };

  // 横屏换台：可见频道里上/下一个
  const changeChannel = (dir: 1 | -1) => {
    if (!channels) return;
    const list = visibleChannels;
    const idx = list.findIndex((c) => c.name === activeName);
    const next = list[(idx + dir + list.length) % list.length];
    if (next) pickChannel(next.name);
  };

  // 手势：竖滑 左半=亮度 / 右半=音量；横滑=切台（左滑上一台 / 右滑下一台）
  const onStageTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const el = e.currentTarget as any;
    // B12：触摸落在控件（小锁 / 横屏钮 / 中央播放）上时把手势让给控件本身，
    //      不初始化手势状态，避免点一下按钮又顺带触发一次「控件显隐」
    if ((e.target as HTMLElement | null)?.closest?.('button')) { el.__sx = null; el.__moved = true; return; }
    el.__sx = t.clientX; el.__sy = t.clientY; el.__moved = false;
    el.__half = t.clientX < window.innerWidth / 2 ? 'left' : 'right';
    el.__accum = 0; el.__bStart = brightnessRef.current; el.__vStart = videoRef.current?.volume ?? 1;
  };
  const onStageTouchMove = (e: React.TouchEvent) => {
    const el = e.currentTarget as any;
    // B4：锁定态禁掉上下滑（亮度/音量）与左右滑（切台）
    if (el.__sx == null || locked) return;
    const t = e.touches[0];
    const dx = t.clientX - el.__sx;
    const dy = t.clientY - el.__sy;
    if (Math.abs(dx) < 16 && Math.abs(dy) < 16) return;
    if (Math.abs(dy) > Math.abs(dx)) {
      const start = el.__half === 'left' ? el.__bStart : el.__vStart;
      const val = Math.max(0, Math.min(1, start + (-dy) / 320));
      if (el.__half === 'left') {
        const b = Math.round(val * 100) / 100;
        setBrightness(b); brightnessRef.current = b;
        try { (window as any).MuHaiAndroid?.setBrightness?.(b); } catch { /* ignore */ }
        if (videoRef.current) videoRef.current.style.filter = `brightness(${b})`;
        showHud('bright', Math.round(val * 100));
      } else {
        if (videoRef.current) { videoRef.current.muted = false; videoRef.current.volume = val; }
        showHud('vol', Math.round(val * 100));
      }
      el.__accum = dy;
    } else {
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) el.__moved = true;
    }
  };
  const onStageTouchEnd = (e: React.TouchEvent) => {
    const el = e.currentTarget as any;
    if (el.__sx == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - el.__sx;
    const dy = t.clientY - el.__sy;
    el.__sx = null; el.__sy = null;
    // 轻触（位移很小）：单击切换横屏控件显隐；双击播放/暂停（竖屏无控件层，toggle 等效无效）
    if (Math.abs(dx) < 16 && Math.abs(dy) < 16) {
      // 选台/换源浮层打开时，单击屏幕（视频区）先关浮层，不动锁与控件
      if (!locked && pickSheet) { setPickSheet(false); return; }
      if (!locked && srcSheet) { setSrcSheet(false); return; }
      // B11：锁定态走独立分支 —— 不判双击、不等 280ms，单击立即切换小锁显隐。
      // 其余控件在锁定态由 CSS 强制隐藏，所以这里只动 landControls 就等于只动小锁。
      if (locked) {
        if (landClickTimer.current) { window.clearTimeout(landClickTimer.current); landClickTimer.current = undefined; }
        setLockHidden((v) => !v);
        return;
      }
      if (landClickTimer.current) {
        // 第二击 = 双击：播放/暂停。
        // M3/M4：绝不改变控件显隐 —— 恢复成第一击之前的样子（隐藏态双击不会把控件弹出来）
        window.clearTimeout(landClickTimer.current);
        landClickTimer.current = undefined;
        const wasVisible = el.__tapVisible !== false;
        togglePlay();
        setLandControls(wasVisible);
        if (wasVisible && !paused) scheduleLandHide();
        return;
      }
      // 第一击：先记下「双击前控件是否可见」，供上面的双击分支还原
      const wasVisible = landControls;
      el.__tapVisible = wasVisible;
      // K3：控件当前是隐藏的 → 第一下就立即唤出，不再干等 280ms
      if (!wasVisible) { setLandControls(true); if (!paused) scheduleLandHide(); }
      // 单击语义仍由 280ms 定时器兜底：原本可见 → 到点隐藏；原本隐藏 → K3 已处理，到点不动
      landClickTimer.current = window.setTimeout(() => {
        landClickTimer.current = undefined;
        if (wasVisible) setLandControls(false);
      }, 280);
      return;
    }
    // 左滑上一台 / 右滑下一台（横向位移 >50px 且明显大于纵向）
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      changeChannel(dx < 0 ? -1 : 1);
    }
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
      // B6：锁定态不弹解锁提示、也不要求「先解锁再返回」。
      //     这里先把锁解掉，然后继续往下走原本的返回逻辑 —— 一次返回键同时完成
      //     「解锁 + 退出横屏」，再按一次才真正离开页面，避免误触直接关掉直播。
      if (locked) setLocked(false);
      if (isFullscreen) { toggleFullscreen(); return false; }
      if (pickSheet) { setPickSheet(false); return false; }
      if (srcSheet) { setSrcSheet(false); return false; }
      if (channels) { setChannels(null); setActiveName(''); setPlaying(null); return false; }
      return prev ? !!prev() : true;
    };
    return () => { (window as any).__onAndroidBack = prev; };
  }, [channels, isFullscreen, pickSheet, srcSheet, toggleFullscreen, locked]);

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
              <button className="lp-back" onClick={() => { clearTapTimer(); setChannels(null); setActiveName(''); setPlaying(null); }}>
                <Icon name="arrow-left" size={18} />
              </button>
              <div className="lp-title">
                <span className="lp-ch-name">{activeName || '未播放'}</span>
                <span className="lp-res">[{resolution}]</span>
              </div>
              <button className="lp-tv" onClick={() => { clearTapTimer(); handleCast(); }} title="投屏">
                <Icon name="tv" size={18} />
              </button>
            </div>
            <div className="lp-stage"
              onTouchStart={onStageTouchStart}
              onTouchMove={onStageTouchMove}
              onTouchEnd={onStageTouchEnd}
            >
              {playing ? (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                // C2：只切 CSS 类把视频提到全屏（不挪 DOM，避免 HLS 重新 attach 导致断流）
                className={'live-video' + (isFullscreen ? ' fs' : '')}
                onPlay={() => setPaused(false)}
                onPause={() => setPaused(true)}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget as HTMLVideoElement;
                  if (v.videoWidth && v.videoHeight) setResolution(`${v.videoWidth}×${v.videoHeight}`);
                }}
              />
              ) : (
                <div className="lp-empty">
                  <Icon name="play" size={28} />
                  <span>点击频道开始播放</span>
                </div>
              )}
              <div className={'lp-ctl' + (landControls ? '' : ' hide') + (locked ? ' locked' : '')}>
                {playing && (
                  <button className="lp-big" title={paused ? '播放' : '暂停'} onClick={togglePlay}>
                    <Icon name={paused ? 'play' : 'pause'} size={28} />
                  </button>
                )}
                {/* A 组：直播竖屏新增小锁（与右下角横屏钮同尺寸、竖排在其正上方） */}
                <button className={'lp-lock' + (locked ? ' on' : '') + (lockHidden ? ' lock-hidden' : '')} onClick={() => { clearTapTimer(); toggleLock(); }} title={locked ? '已锁定' : '锁定屏幕'}>
                  <Icon name={locked ? 'lock' : 'lock-open'} size={18} />
                </button>
                <button className="lp-rotate" onClick={() => { clearTapTimer(); toggleFullscreen(); }} title="横屏">
                  <Icon name="rotate" size={18} />
                </button>
              </div>
              {hud && (
                <div className="vp-hud">
                  <span className="vp-hud-ico"><Icon name={hud.type === 'bright' ? 'sun' : 'volume'} size={20} /></span>
                  <div className="vp-hud-bar"><div style={{ width: hud.value + '%' }} /></div>
                  <span className="vp-hud-val">{hud.value}%</span>
                </div>
              )}
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
                    {c.sources.length > 0 && <div className="ch-src-hint">源 {c.sources.length} 个</div>}
                  </div>
                </div>
              ))}
              {visibleChannels.length === 0 && <div className="empty sm">该分类暂无频道</div>}
            </div>
          </div>
        </div>
      )}

      {loading && <div className="empty sm">正在加载直播频道…</div>}

      {/* 真实 DLNA 投屏浮层 */}
      {showCast && (
        <CastOverlay
          videoUrl={curUrl}
          onClose={() => setShowCast(false)}
          onCast={() => {
            setShowCast(false);
            toast('已投屏到设备');
          }}
        />
      )}

      {/* C1 · 横屏黑底遮罩：遮住下面的竖屏页面（先于控件层渲染，z-index 9998） */}
      {isFullscreen && channels && <div className="land-backdrop" />}

      {/* 横屏浮层：选台 + 换源条 + 底部控制 */}
      {isFullscreen && channels && (
        <div className={'land-overlay' + (landControls ? '' : ' hide') + (locked ? ' locked' : '')}
          // B4+B11：锁定态仍要接收 touchStart（B11 的「单击切小锁显隐」要靠它记录轻触起点），
          // 滑动则在 onStageTouchMove 内部被 locked 拦掉，所以这里不再整体 return。
          onTouchStart={onStageTouchStart}
          onTouchMove={onStageTouchMove}
          onTouchEnd={onStageTouchEnd}
        >
          <div className="land-top">
            <button className="land-back" onClick={() => { clearTapTimer(); toggleFullscreen(); }}>
              <Icon name="arrow-left" size={18} />
            </button>
            <div className="land-title">
              <span>{activeName}</span>
              <span className="lp-res">[{resolution}]</span>
            </div>
            <button className={'land-lock' + (locked ? ' on' : '') + (lockHidden ? ' lock-hidden' : '')} onClick={() => { clearTapTimer(); toggleLock(); }} title={locked ? '已锁定' : '锁定屏幕'}>
              <Icon name={locked ? 'lock' : 'lock-open'} size={18} />
            </button>
            <button className="land-tv" onClick={(e) => { e.stopPropagation(); clearTapTimer(); handleCast(); }} title="投屏">
              <Icon name="tv" size={18} />
            </button>
          </div>
          <div className="land-center">
            <button onClick={() => changeChannel(-1)} title="上一个"><Icon name="skip-back" size={26} /></button>
            <button className="main" onClick={togglePlay} title={paused ? '播放' : '暂停'}>
              <Icon name={paused ? 'play' : 'pause'} size={32} />
            </button>
            <button onClick={() => changeChannel(1)} title="下一个"><Icon name="skip-forward" size={26} /></button>
          </div>
          {hud && (
            <div className="vp-hud">
              <span className="vp-hud-ico"><Icon name={hud.type === 'bright' ? 'sun' : 'volume'} size={20} /></span>
              <div className="vp-hud-bar"><div style={{ width: hud.value + '%' }} /></div>
              <span className="vp-hud-val">{hud.value}%</span>
            </div>
          )}
          <div className="land-bottom">
            <button className={'land-src' + (srcSheet ? ' on' : '')} onClick={() => setSrcSheet((s) => !s)} title="换源">
              源{activeSrc}
            </button>
            <button className="land-pip" onClick={handlePip} title="画中画"><Icon name="pip" size={18} /></button>
            <button className="land-pbtn" onClick={togglePlay} title={paused ? '播放' : '暂停'}>
              <Icon name={paused ? 'play' : 'pause'} size={18} />
            </button>
            <button className={'land-list' + (pickSheet ? ' on' : '')} onClick={() => setPickSheet((s) => !s)} title="选台">
              <Icon name="list" size={18} />
            </button>
          </div>

          {/* 横屏选台浮层 */}
          {pickSheet && (
            <div className="land-pick" onTouchEnd={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
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
                      {c.sources.length > 0 && <div className="ch-src-hint">源 {c.sources.length} 个</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 横屏换源条 */}
          {srcSheet && curChannel && (
            <div className="land-srcbar" onTouchEnd={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
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
