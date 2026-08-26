import { useEffect, useRef, useState } from 'react';
import { usePlayer, fmtTime, player } from '../lib/playerStore';
import { useMediaResolver } from '../lib/playback';
import { useLibrary } from '../lib/library';
import { AppSettings, useSettings } from '../lib/settings';
import { MediaItem, SourceConfig } from '../engine/types';
import { gradientFor, initial } from '../lib/cover';
import { CastOverlay } from '../components/CastOverlay';
import { downloadStore } from '../lib/downloads';
import { attachHls, detachHls } from '../lib/hlsPlayer';
import { isTauri, saveBlob } from '../lib/tauriBridge';
import { Icon } from '../components/Icon';
import { ProxiedImg } from '../components/ProxiedImg';

// ===== 播放器选项（持久化到 localStorage） =====
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
// 解码循环：系统 → 硬解 → 软解 → Exo（文字仅需显示这四个，不带 IJK 前缀）
const DECODE_CYCLE = ['system', 'ijk-hard', 'ijk-soft', 'exo'] as const;
const DECODE_LABEL: Record<string, string> = { system: '系统', 'ijk-hard': '硬解', 'ijk-soft': '软解', exo: 'Exo' };
const QUALITIES = ['480P', '720P', '1080P', '4K'];
const SCALE_OPTS = ['默认', '16:9', '4:3', '填充', '原始', '裁剪'];
const AUDIO_OPTS = ['关闭', '影院', '重低音', '环绕', 'HiFi', '人声'];
// 线路命名：对齐设计文件“默认线路 / 备用线路 A / 备用线路 B / 海外线路”
const LINE_NAMES = ['默认线路', '备用线路 A', '备用线路 B', '海外线路'];

const speedLabel = (s: number) => (s === 1 ? '1.0x' : s + 'x');

// 解析 .srt / .vtt 字幕为 {time, text} 队列
function parseSubtitle(text: string): { time: number; text: string }[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const cues: { time: number; text: string }[] = [];
  let t: number | null = null;
  let buf: string[] = [];
  const ts = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/;
  const toSec = (m: RegExpMatchArray) => +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
  for (const line of lines) {
    if (line.includes('-->')) {
      const m = line.split('-->')[0].match(ts);
      if (m) t = toSec(m);
      continue;
    }
    if (t !== null && line.trim() === '') {
      if (buf.length) cues.push({ time: t, text: buf.join('\n').trim() });
      buf = [];
      t = null;
    } else if (t !== null && line.trim()) {
      buf.push(line.trim());
    }
  }
  if (t !== null && buf.length) cues.push({ time: t, text: buf.join('\n').trim() });
  return cues;
}

function getActiveCue(cues: { time: number; text: string }[] | undefined, progress: number): string | null {
  if (!cues || cues.length === 0) return null;
  let cur: string | null = null;
  for (const c of cues) {
    if (c.time <= progress + 0.4) cur = c.text;
    else break;
  }
  return cur;
}

export function VideoPlayer({
  detail,
  episodeIndex,
  line,
  startAt = 0,
  onLineChange,
  onSelectEpisode,
  onClose,
  library,
  sources,
  settings,
}: {
  detail: MediaItem;
  episodeIndex: number;
  line: number;
  startAt?: number;
  onLineChange: (i: number) => void;
  onSelectEpisode: (i: number) => void;
  onClose: () => void;
  library: ReturnType<typeof useLibrary>;
  sources: SourceConfig[];
  settings: AppSettings;
}) {
  const { update: updateSettings } = useSettings();
  const state = usePlayer();
  const { ensureResolved } = useMediaResolver(sources);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const epRef = useRef<HTMLDivElement>(null);
  const [speed, setSpeed] = useState(settings.playbackRate || 1);
  const [collapsed, setCollapsed] = useState(false);
  const [showCast, setShowCast] = useState(false);
  const [castDevice, setCastDevice] = useState<string | null>(null);
  const [localCues, setLocalCues] = useState<{ time: number; text: string }[]>([]);
  const [showSubStyle, setShowSubStyle] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [faved, setFaved] = useState(false);
  const [locked, setLocked] = useState(false);
  const [danmaku, setDanmaku] = useState<boolean>(!!settings.enableDanmaku);
  // 控件点击显隐（点画面 toggle；播放后自动隐藏；锁屏态常显不隐藏）
  const [controlsVisible, setControlsVisible] = useState(true);
  const [asc, setAsc] = useState(true);
  const hideTimer = useRef<number | undefined>(undefined);
  // 横滑快进/快退时间气泡（点播播放窗口左右滑 ±10s）
  const [seekBubble, setSeekBubble] = useState<{ dir: 1 | -1; delta: number; target: number } | null>(null);
  const seekBubbleTimer = useRef<number | undefined>(undefined);
  // 真实分辨率药丸（设计文件 [1920x804]）+ 亮度/音量手势状态
  const [resText, setResText] = useState('');
  const [brightness, setBrightness] = useState(1);
  const brightnessRef = useRef(1);
  const [hud, setHud] = useState<{ type: 'bright' | 'vol'; value: number } | null>(null);
  const hudTimer = useRef<number | undefined>(undefined);

  // 播放器专属偏好（持久化）
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [decodeMode, setDecodeMode] = useState<string>(() => localStorage.getItem('rf_decode') || 'exo');
  const [quality, setQuality] = useState<string>(() => localStorage.getItem('rf_quality') || '1080P');
  const [scaleMode, setScaleMode] = useState<string>(() => localStorage.getItem('rf_scale') || '默认');
  const [audioMode, setAudioMode] = useState<string>(() => localStorage.getItem('rf_audio') || '关闭');
  const [autoPlay, setAutoPlay] = useState<boolean>(() => localStorage.getItem('rf_autoplay') !== '0');
  const [landscape, setLandscape] = useState(false);
  const [clock, setClock] = useState('');

  const introDone = useRef(false);
  const appliedStartAt = useRef(false);
  const loadTimer = useRef<number | undefined>(undefined);

  const groups = (detail.raw?.lineGroups as any[] | undefined) ?? [];
  const lines = groups.length || (detail.raw?.lines as number) || 1;
  const progressKey = `${detail.sourceId}:${detail.id}`;
  const perItem = settings.skipByItem[progressKey];
  const introSec = perItem?.intro ?? settings.skipIntro;
  const outroSec = perItem?.outro ?? settings.skipOutro;

  // 横屏（移动端）：仅窄屏横置进入沉浸布局
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape) and (max-width: 900px)');
    const on = () => setLandscape(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // 时钟（横屏顶栏时间/电量展示）
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    };
    tick();
    const id = window.setInterval(tick, 20000);
    return () => window.clearInterval(id);
  }, []);

  // 主动请求系统横屏（Android 原生桥；不可用则退化为 CSS 铺满）
  const requestOrientation = (ori: 'landscape' | 'portrait') => {
    try { (window as any).MuHaiAndroid?.setOrientation?.(ori); } catch { /* ignore */ }
  };

  // 横屏自动旋转：进入横屏态时请求原生横屏；退出时恢复竖屏
  useEffect(() => {
    requestOrientation(landscape ? 'landscape' : 'portrait');
  }, [landscape]);

  // 返回手势衔接：先关最上层浮层
  useEffect(() => {
    (window as any).__playerBack = () => {
      if (settingsOpen) { setSettingsOpen(false); return true; }
      if (showCast) { setShowCast(false); return true; }
      if (showSubStyle) { setShowSubStyle(false); return true; }
      if (showSkip) { setShowSkip(false); return true; }
      return false;
    };
    return () => { (window as any).__playerBack = undefined; };
  }, [settingsOpen, showCast, showSubStyle, showSkip]);

  useEffect(() => {
    player.attachVideo(videoRef.current);
    return () => { detachHls(videoRef.current); player.attachVideo(null); };
  }, []);

  // 切换剧集/线路：解析并加载
  useEffect(() => {
    if (!state.current) return;
    const v = videoRef.current;
    if (!v) return;
    let alive = true;
    appliedStartAt.current = false;
    introDone.current = false;
    setResolving(true);
    setErr(null);
    const wantResume = startAt;
    ensureResolved(state.current).then(async (it) => {
      if (!alive || !v) return;
      if (!it.playUrl) {
        setResolving(false);
        setErr('该音源未返回可播放地址，换条线路或换个音源试试。');
        return;
      }
      await attachHls(v, it.playUrl, {
        headers: it.raw?.headers as Record<string, string> | undefined,
        onError: () => {
          if (!alive) return;
          detachHls(v);
          setResolving(false);
          setErr('视频加载失败，可能是网络或防盗链限制，换个线路试试。');
        },
      });
      const onMeta = () => {
        v.removeEventListener('loadedmetadata', onMeta);
        if (wantResume > 0 && wantResume < (v.duration || 1e9) - 3) v.currentTime = wantResume;
        appliedStartAt.current = true;
        if (alive) setResolving(false);
      };
      v.addEventListener('loadedmetadata', onMeta);
      loadTimer.current = window.setTimeout(() => {
        if (alive && v.readyState < 1) {
          detachHls(v);
          setResolving(false);
          setErr('视频加载超时，请检查网络或换源。');
        }
      }, 8000);
      v.playbackRate = speed;
      if (state.isPlaying) v.play().catch(() => {});
    }).catch(() => {
      if (alive) {
        setResolving(false);
        setErr('解析播放地址失败，请换个音源。');
      }
    });
    return () => {
      alive = false;
      if (loadTimer.current) window.clearTimeout(loadTimer.current);
      detachHls(v);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.current?.id, state.current?.playUrl, episodeIndex, retryNonce]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !state.current) return;
    if (state.isPlaying) v.play().catch(() => {});
    else v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isPlaying]);

  useEffect(() => { if (videoRef.current) videoRef.current.volume = state.muted ? 0 : state.volume; }, [state.volume, state.muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = speed; }, [speed]);
  useEffect(() => { updateSettings({ playbackRate: speed }); }, [speed]);
  useEffect(() => { setLocalCues([]); }, [detail.id, episodeIndex]);

  // 片头跳过
  const trySkipIntro = () => {
    const v = videoRef.current;
    if (!v || !introSec || introDone.current) return;
    if (v.currentTime < 0.6) {
      introDone.current = true;
      player.seek(introSec);
      v.currentTime = introSec;
    }
  };

  // 片尾提前连播
  const trySkipOutro = () => {
    const v = videoRef.current;
    if (!v || !outroSec || !state.duration) return;
    const remain = state.duration - v.currentTime;
    if (autoPlay && remain <= outroSec && remain > 0.5) {
      if (detail.episodes && episodeIndex < detail.episodes.length - 1) onSelectEpisode(episodeIndex + 1);
      else player.onEnded();
    }
  };

  const onScreenshot = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob(async (blob) => {
      if (!blob) return;
      const name = `${detail.title}_${detail.episodes?.[episodeIndex]?.name ?? episodeIndex + 1}.png`;
      if (isTauri()) await saveBlob(blob, name);
      else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    }, 'image/png');
  };

  const onPip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* 不支持时静默 */
    }
  };

  const onLoadSubtitle = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setLocalCues(parseSubtitle(String(reader.result)));
    reader.readAsText(file);
  };

  const retry = () => {
    setErr(null);
    setResolving(true);
    setRetryNonce((n) => n + 1);
  };

  // 解码循环切换
  const toggleDecode = () => {
    const i = DECODE_CYCLE.indexOf(decodeMode as any);
    const next = DECODE_CYCLE[(i + 1) % DECODE_CYCLE.length] as string;
    setDecodeMode(next);
    localStorage.setItem('rf_decode', next);
  };
  const setDecode = (id: string) => {
    setDecodeMode(id);
    localStorage.setItem('rf_decode', id);
  };
  const decodeLabel = () => DECODE_LABEL[decodeMode] ?? 'Exo';

  const cycleSpeed = () => {
    const i = SPEEDS.indexOf(speed);
    setSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
  };
  const cycleQuality = () => {
    const i = QUALITIES.indexOf(quality);
    const n = QUALITIES[(i + 1) % QUALITIES.length];
    setQuality(n);
    localStorage.setItem('rf_quality', n);
  };
  const cycleAudio = () => {
    const i = AUDIO_OPTS.indexOf(audioMode);
    const n = AUDIO_OPTS[(i + 1) % AUDIO_OPTS.length];
    setAudioMode(n);
    localStorage.setItem('rf_audio', n);
  };

  const toggleLandscape = () => setLandscape((v) => !v);

  const toggleFullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  const scrollToEpisodes = () => epRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // 点击画面：toggle 控件显隐；播放态 3s 后自动隐藏
  const scheduleHide = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (locked || !state.isPlaying) return;
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 3000);
  };
  const toggleControls = () => {
    setControlsVisible((v) => {
      const next = !v;
      if (next) scheduleHide();
      return next;
    });
  };

  // 手势：竖滑 左半=亮度 / 右半=音量；横滑=进度快进/快退（点播）。方向区分互不冲突。
  const showHud = (type: 'bright' | 'vol', value: number) => {
    setHud({ type, value });
    if (hudTimer.current) window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setHud(null), 800);
  };
  const SWIPE_STEP = 10; // 每跨 80px 跳 10s
  const SWIPE_EDGE = 40; // 左边缘 40px 内右滑 = 返回
  const onStageTouchStart = (e: React.TouchEvent) => {
    if (locked) return;
    const t = e.touches[0];
    const el = stageRef.current as any;
    if (!el) return;
    el.__sx = t.clientX;
    el.__sy = t.clientY;
    el.__accum = 0;
    el.__dir = 0;
    el.__backing = false;
    el.__half = t.clientX < window.innerWidth / 2 ? 'left' : 'right';
    el.__bStart = brightnessRef.current;
    el.__vStart = state.volume;
  };
  const onStageTouchMove = (e: React.TouchEvent) => {
    const el = stageRef.current as any;
    if (el == null || el.__sx == null || locked) return;
    const t = e.touches[0];
    const dx = t.clientX - el.__sx;
    const dy = t.clientY - el.__sy;
    if (el.__sx <= SWIPE_EDGE && dx > 60 && Math.abs(dy) < 80) { el.__backing = true; return; }
    if (el.__backing) return;
    if (Math.abs(dx) < 16 && Math.abs(dy) < 16) return; // 死区
    if (Math.abs(dy) > Math.abs(dx)) {
      // 竖向：左半亮度 / 右半音量
      const start = el.__half === 'left' ? el.__bStart : el.__vStart;
      const val = Math.max(0, Math.min(1, start + (-dy) / 320));
      if (el.__half === 'left') {
        const b = Math.round(val * 100) / 100;
        setBrightness(b);
        brightnessRef.current = b;
        try { (window as any).MuHaiAndroid?.setBrightness?.(b); } catch { /* ignore */ }
        showHud('bright', Math.round(val * 100));
      } else {
        if (videoRef.current) { videoRef.current.muted = false; videoRef.current.volume = val; }
        showHud('vol', Math.round(val * 100));
      }
      el.__accum = dy;
    } else {
      // 横向：点播进度快进/快退
      const dir = dx > 0 ? 1 : dx < 0 ? -1 : el.__dir;
      const stepPx = 80;
      const crossed = Math.floor(Math.abs(dx) / stepPx) - Math.floor(Math.abs(el.__accum) / stepPx);
      if (crossed > 0 && dir !== 0) {
        const d = state.duration || 0;
        const target = Math.max(0, Math.min(d, state.progress + dir * SWIPE_STEP * crossed));
        if (videoRef.current) videoRef.current.currentTime = target;
        player.setProgress(target);
        el.__accum = dx;
        el.__dir = dir;
        setSeekBubble({ dir: dir as 1 | -1, delta: Math.abs(dx), target });
        if (seekBubbleTimer.current) window.clearTimeout(seekBubbleTimer.current);
        seekBubbleTimer.current = window.setTimeout(() => setSeekBubble(null), 600);
      }
    }
  };
  const onStageTouchEnd = () => {
    const el = stageRef.current as any;
    if (el) {
      if (el.__backing) {
        if (settingsOpen) setSettingsOpen(false);
        else if (showCast) setShowCast(false);
        else if (showSubStyle) setShowSubStyle(false);
        else if (showSkip) setShowSkip(false);
        else if (landscape) setLandscape(false);
        else onClose();
      }
      el.__sx = null; el.__sy = null; el.__accum = 0; el.__dir = 0; el.__backing = false; el.__half = null;
    }
  };
  // 播放开始即自动隐藏控件；锁屏时强制常显
  useEffect(() => {
    if (state.isPlaying && !locked) {
      setControlsVisible(false);
    } else {
      setControlsVisible(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isPlaying, locked]);

  const toggleDanmaku = () => {
    const next = !danmaku;
    setDanmaku(next);
    updateSettings({ enableDanmaku: next });
  };

  const ss = settings.subtitleStyle;
  const cues = localCues.length ? localCues : detail.subtitles?.[0]?.cues;
  const activeCue = (settings.enableSubtitle && danmaku === false) ? getActiveCue(cues, state.progress) : null;
  const videoStyle: React.CSSProperties = {
    objectFit: scaleMode === '填充' ? 'fill' : scaleMode === '裁剪' ? 'cover' : 'contain',
    filter: brightness < 1 ? `brightness(${brightness})` : undefined,
  };
  const tags: string[] = Array.isArray(detail.raw?.tags)
    ? (detail.raw!.tags as string[]).slice(0, 5)
    : Array.isArray(detail.raw?.genres)
    ? (detail.raw!.genres as string[]).slice(0, 5)
    : [];
  const vr = detail.raw as any;
  const filmYear = vr?.vod_year || vr?.year;
  const director = vr?.vod_director || vr?.director;
  const actor = vr?.vod_actor || vr?.actor;

  const epName = detail.episodes?.[episodeIndex]?.name ?? `第${episodeIndex + 1}集`;

  if (collapsed) {
    return (
      <div className="video-mini-bar" onClick={() => setCollapsed(false)}>
        <span className="vm-thumb" style={{ background: gradientFor(detail.title) }}>{initial(detail.title)}</span>
        <span className="vm-title">{detail.title} · {epName}{castDevice ? ` · 投屏到 ${castDevice}` : ''}</span>
        <span className="vm-expand"><Icon name="chevron-down" size={16} /> 展开</span>
      </div>
    );
  }

  return (
    <div className={'player-root' + (landscape ? ' landscape' : '')}>
      {/* ===== 播放器卡片（竖屏）/ 横屏舞台 ===== */}
      <div
        className={'player-card' + (landscape ? ' land' : '')}
        ref={stageRef}
        onTouchStart={onStageTouchStart}
        onTouchMove={onStageTouchMove}
        onTouchEnd={onStageTouchEnd}
      >
        <div className="screen">
          <div className="poster" />
          <video
            ref={videoRef}
            style={videoStyle}
            controls={false}
            onClick={toggleControls}
            onTimeUpdate={(e) => {
              const v = e.target as HTMLVideoElement;
              player.setProgress(v.currentTime);
              library.setWatchProgress(progressKey, v.currentTime);
              trySkipIntro();
              trySkipOutro();
            }}
            onLoadedMetadata={(e) => {
              const v = e.target as HTMLVideoElement;
              player.setDuration(v.duration);
              if (v.videoWidth && v.videoHeight) setResText(`${v.videoWidth}x${v.videoHeight}`);
            }}
            onError={() => {
              if (videoRef.current) detachHls(videoRef.current);
              setResolving(false);
              setErr('视频解码失败或地址无效，换个线路试试。');
            }}
            onEnded={() => {
              if (detail.episodes && episodeIndex < detail.episodes.length - 1) onSelectEpisode(episodeIndex + 1);
              else player.onEnded();
            }}
          />

          {resolving && !err && (
            <div className="vp-loading">
              <div className="vp-spinner" />
              <span>加载中…</span>
            </div>
          )}
          {err && (
            <div className="vp-error">
              <p>{err}</p>
              <button className="mini" onClick={retry}>重试</button>
            </div>
          )}

          {/* 弹幕层 */}
          {danmaku && detail.danmaku && detail.danmaku.length > 0 && (
            <Danmaku active={state.isPlaying} seed={detail.id + episodeIndex} items={detail.danmaku} />
          )}
          {activeCue && (
            <div
              className={`vp-subtitle${ss.position === 'top' ? ' sub-top' : ''}${ss.outline ? ' sub-outline' : ''}${ss.bg ? ' sub-bg' : ''}`}
              style={{ fontSize: ss.size + 'px', color: ss.color } as React.CSSProperties}
            >
              {activeCue}
            </div>
          )}
          {castDevice && <div className="vp-cast-flag"><Icon name="cast" size={14} /> 投屏中：{castDevice}</div>}

          {/* 中央大播放钮：暂停且无加载/错误时显示，点击播放 */}
          {!state.isPlaying && !resolving && !err && (
            <button className="big-btn" onClick={() => player.toggle()} title="播放"><Icon name="play" size={30} /></button>
          )}

          {/* 横滑快进/快退时间气泡 */}
          {seekBubble && (
            <div className="seek-bubble">
              <Icon name={seekBubble.dir === 1 ? 'arrow-right' : 'arrow-left'} size={20} />
              <span>{fmtTime(seekBubble.target)}</span>
            </div>
          )}

          {/* 亮度/音量手势 HUD */}
          {hud && (
            <div className="vp-hud">
              <span className="vp-hud-ico"><Icon name={hud.type === 'bright' ? 'sun' : 'volume'} size={20} /></span>
              <div className="vp-hud-bar"><div style={{ width: hud.value + '%' }} /></div>
              <span className="vp-hud-val">{hud.value}%</span>
            </div>
          )}

          {/* ============ 竖屏：顶/中/底 三段 ============ */}
          {!landscape && (
            <div className={'overlay' + (controlsVisible ? '' : ' hide')}>
              <div className="top">
                <button className="back" onClick={onClose} title="返回"><Icon name="arrow-left" size={18} /></button>
                <div className="ttl">
                  <span className="name">{detail.title} · {epName}</span>
                  <span className="res">[{resText || '1920x804'}]</span>
                </div>
                <div className="acts">
                  <button className={'icon' + (locked ? ' on' : '')} onClick={() => setLocked((v) => !v)} title={locked ? '已锁定' : '锁定屏幕'}><Icon name="lock" size={16} /></button>
                  <button className={'icon' + (danmaku ? ' on' : '')} onClick={toggleDanmaku} disabled={!detail.danmaku || detail.danmaku.length === 0} title={danmaku ? '弹幕开' : '弹幕关'}><Icon name="message" size={16} /></button>
                </div>
              </div>
              <div className="center"><button className="big-btn" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}><Icon name={state.isPlaying ? 'pause' : 'play'} size={30} /></button></div>
              <div className="bottom">
                <span className="play-ico" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}><Icon name={state.isPlaying ? 'pause' : 'play'} size={18} /></span>
                <div className="bar">
                  <input type="range" min={0} max={state.duration || 0} value={state.progress} onChange={(e) => player.seek(Number(e.target.value))} />
                </div>
                <button className="land" onClick={toggleLandscape} title="横屏"><Icon name="rotate" size={18} /></button>
              </div>
            </div>
          )}

          {/* ============ 横屏：顶/侧/中/底 ======== */}
          {landscape && (
            <div className={'overlay' + (controlsVisible ? '' : ' hide')}>
              <div className="top">
                <button className="back" onClick={onClose} title="返回"><Icon name="arrow-left" size={18} /></button>
                <div className="ttl">
                  <span className="name">{detail.title} · {epName}</span>
                  <span className="res">[{resText || '1920x804'}]</span>
                </div>
                <div className="status">
                  <Icon name="clock" size={15} />
                  <Icon name="battery" size={16} />
                  <span>{clock}</span>
                </div>
              </div>

              <div className="side left">
                <button className={'icon' + (locked ? ' on' : '')} onClick={() => setLocked((v) => !v)} title={locked ? '已锁定' : '锁定屏幕'}><Icon name="lock" size={20} /></button>
                <button className={'icon' + (danmaku ? ' on' : '')} onClick={toggleDanmaku} disabled={!detail.danmaku || detail.danmaku.length === 0} title={danmaku ? '弹幕开' : '弹幕关'}><Icon name="message" size={20} /></button>
              </div>
              <div className="side right">
                <button className="icon" onClick={() => setShowCast(true)} title="投屏"><Icon name="cast" size={20} /></button>
                <button className="icon" onClick={onPip} title="画中画"><Icon name="pip" size={20} /></button>
              </div>

              <div className="center">
                <button className="ctrl" onClick={() => episodeIndex > 0 && onSelectEpisode(episodeIndex - 1)} title="上一集"><Icon name="skip-back" size={26} /></button>
                <button className="ctrl main" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}><Icon name={state.isPlaying ? 'pause' : 'play'} size={32} /></button>
                <button className="ctrl" onClick={() => detail.episodes && episodeIndex < detail.episodes.length - 1 && onSelectEpisode(episodeIndex + 1)} title="下一集"><Icon name="skip-forward" size={26} /></button>
              </div>

              <div className="bottom">
                <div className="prow">
                  <span className="pi" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}><Icon name={state.isPlaying ? 'pause' : 'play'} size={18} /></span>
                  <span className="t">{fmtTime(state.progress)}</span>
                  <div className="bar">
                    <input type="range" min={0} max={state.duration || 0} value={state.progress} onChange={(e) => player.seek(Number(e.target.value))} />
                  </div>
                  <span className="t">{fmtTime(state.duration)}</span>
                  <button className="land" onClick={toggleLandscape} title="竖屏"><Icon name="rotate-portrait" size={18} /></button>
                </div>
                <div className="tools">
                  <button className={'tool' + (DECODE_CYCLE.indexOf(decodeMode as any) >= 0 ? ' on' : '')} onClick={toggleDecode}><Icon name="sliders" size={15} /><span>{decodeLabel()}</span></button>
                  <button className="tool" onClick={retry}><Icon name="refresh" size={15} /><span>刷新</span></button>
                  <button className="tool" onClick={() => { const v = videoRef.current; if (v) { v.currentTime = 0; v.play().catch(() => {}); } }}><Icon name="replay" size={15} /><span>重播</span></button>
                  <button className='tool' onClick={() => setShowSubStyle(true)}><Icon name="captions" size={15} /><span>字幕</span></button>
                  <button className="tool" onClick={() => setShowSkip(true)}><Icon name="fast-forward" size={15} /><span>片头</span></button>
                  <button className="tool" onClick={() => setShowSkip(true)}><Icon name="fast-forward" size={15} style={{ transform: 'scaleX(-1)' }} /><span>片尾</span></button>
                  <button className={'tool' + (audioMode !== '关闭' ? ' on' : '')} onClick={cycleAudio}><Icon name="volume" size={15} /><span>{audioMode === '关闭' ? '音效' : audioMode}</span></button>
                  <button className="tool" onClick={cycleQuality}><Icon name="sparkles" size={15} /><span>{quality}</span></button>
                  <button className="tool" onClick={scrollToEpisodes}><Icon name="list" size={15} /><span>选集</span></button>
                  <button className="tool" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={15} /><span>设置</span></button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ===== 竖屏信息区（按设计文件：info-card / tags / actions / section / intro） ===== */}
      {!landscape && (
        <div className="vp-body">
          <div className="info-card">
            <div className="info-poster">
              {detail.cover ? <ProxiedImg src={detail.cover} alt="" /> : <span style={{ color: '#fff', fontSize: 26 }}>{initial(detail.title)}</span>}
            </div>
            <div className="info-body">
              <div className="info-title">{detail.title}</div>
              <div className="info-score">{(detail.raw as any)?.rating || '8.4'}<span className="stars">★★★★<span className="empty">★</span></span></div>
              <div className="info-meta">
                {tags.length > 0 && <><span className="label">类型</span> {tags.slice(0, 3).join(' / ')}　</>}
                {filmYear && <><span className="label">年份</span> {filmYear}　</>}
                <br />
                {director && <><span className="label">导演</span> {director}　</>}
                {actor && <><span className="label">主演</span> {actor}</>}
              </div>
              <button className={'fav-btn' + (faved ? ' on' : '')} onClick={() => setFaved((v) => !v)}>
                <Icon name={faved ? 'heart-filled' : 'heart'} size={14} />{faved ? '已收藏' : '加入收藏'}
              </button>
            </div>
          </div>

          <div className="tags">
            {tags.map((t, i) => <span key={i} className={i === 0 ? 'hot' : ''}>{t}</span>)}
          </div>

          {/* 4 操作按钮（缓存/解码/投屏/设置）— 占位展示，待用户确认哪些要接 */}
          <div className="actions">
            <button onClick={() => downloadStore.start(detail)} title="缓存"><span className="circle"><Icon name="download" size={24} /></span>缓存</button>
            <button className={DECODE_CYCLE.indexOf(decodeMode as any) >= 0 ? 'on' : ''} onClick={toggleDecode} title="解码（点击循环切换）"><span className="circle"><Icon name="sliders" size={24} /></span>{decodeLabel()}</button>
            <button onClick={() => setShowCast(true)} title="投屏"><span className="circle"><Icon name="cast" size={24} /></span>投屏</button>
            <button onClick={() => setSettingsOpen(true)} title="播放器设置"><span className="circle"><Icon name="settings" size={24} /></span>设置</button>
          </div>

          {lines > 1 && (
            <div className="section">
              <div className="sec-head"><span className="sec-title">线路</span><span className="sec-more" onClick={() => {}}>自动选速 &gt;</span></div>
              <div className="line-row">
                {Array.from({ length: lines }).map((_, i) => (
                  <button key={i} className={i === line ? 'active' : ''} onClick={() => onLineChange(i)}>{LINE_NAMES[i] ?? `线路${i + 1}`}</button>
                ))}
              </div>
            </div>
          )}

          {detail.episodes && detail.episodes.length > 1 && (
            <div className="section">
              <div className="sec-head"><span className="sec-title">选集</span><span className="sec-more" onClick={() => setAsc((v) => !v)}>{asc ? '正序 ▾' : '倒序 ▴'}</span></div>
              <div className="ep-grid">
                {(() => {
                  const order = asc ? detail.episodes!.map((_, i) => i) : detail.episodes!.map((_, i) => detail.episodes!.length - 1 - i);
                  return order.map((i) => {
                    const ep = detail.episodes![i];
                    return (
                      <button key={i} className={(i === episodeIndex ? 'active' : '') + (ep.locked ? ' locked' : '')} onClick={() => onSelectEpisode(i)}>{ep.locked ? '锁' : ep.name}</button>
                    );
                  });
                })()}
              </div>
            </div>
          )}

          {(() => {
            const raw = detail.raw as any;
            const intro = raw?.vod_blurb || raw?.vod_content || raw?.desc;
            return intro ? <div className="intro"><div className="sec-head"><span className="sec-title">介绍</span></div><p>{String(intro)}</p></div> : null;
          })()}
        </div>
      )}

      {/* 字幕样式面板 */}
      {showSubStyle && (
        <div className="vp-panel">
          <div className="vp-panel-head">字幕样式
            <button className="link" onClick={() => setShowSubStyle(false)}>关闭</button>
          </div>
          <label>字号 <b>{ss.size}px</b>
            <input type="range" min={14} max={48} step={1} value={ss.size} onChange={(e) => updateSettings({ subtitleStyle: { ...ss, size: Number(e.target.value) } })} />
          </label>
          <label>颜色 <input type="color" value={ss.color} onChange={(e) => updateSettings({ subtitleStyle: { ...ss, color: e.target.value } })} /></label>
          <div className="vp-panel-row">
            <span>位置</span>
            <button className={'mini' + (ss.position === 'bottom' ? ' active' : '')} onClick={() => updateSettings({ subtitleStyle: { ...ss, position: 'bottom' } })}>底部</button>
            <button className={'mini' + (ss.position === 'top' ? ' active' : '')} onClick={() => updateSettings({ subtitleStyle: { ...ss, position: 'top' } })}>顶部</button>
          </div>
          <div className="vp-panel-row">
            <label className="row"><input type="checkbox" checked={ss.outline} onChange={(e) => updateSettings({ subtitleStyle: { ...ss, outline: e.target.checked } })} /> 描边</label>
            <label className="row"><input type="checkbox" checked={ss.bg} onChange={(e) => updateSettings({ subtitleStyle: { ...ss, bg: e.target.checked } })} /> 背景条</label>
          </div>
        </div>
      )}

      {/* 跳过片头片尾 */}
      {showSkip && (
        <div className="vp-panel">
          <div className="vp-panel-head">跳过设置（仅对本剧《{detail.title}》生效）
            <button className="link" onClick={() => setShowSkip(false)}>关闭</button>
          </div>
          <label>片头跳过(秒)
            <input type="number" min={0} value={perItem?.intro ?? settings.skipIntro} onChange={(e) => updateSettings({ skipByItem: { ...settings.skipByItem, [progressKey]: { intro: Number(e.target.value) || 0, outro: perItem?.outro ?? settings.skipOutro } } })} />
          </label>
          <label>片尾提前(秒)
            <input type="number" min={0} value={perItem?.outro ?? settings.skipOutro} onChange={(e) => updateSettings({ skipByItem: { ...settings.skipByItem, [progressKey]: { intro: perItem?.intro ?? settings.skipIntro, outro: Number(e.target.value) || 0 } } })} />
          </label>
          <p className="muted sm">在播放页设置后，本剧每次打开都会自动按此跳过（覆盖全局设置）。</p>
        </div>
      )}

      {/* 播放器设置抽屉（按设计文件 .drawer） */}
      {settingsOpen && (
        <div className="drawer-mask" onClick={() => setSettingsOpen(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-handle" />
            <div className="drawer-title">播放器</div>

            <div className="dg"><div className="dg-label">解码器</div><div className="dg-row">
              {DECODE_CYCLE.map((d) => (
                <button key={d} className={decodeMode === d ? 'on' : ''} onClick={() => setDecode(d)}>{DECODE_LABEL[d]}</button>
              ))}
            </div></div>

            <div className="dg"><div className="dg-label">画面缩放</div><div className="dg-row">
              {SCALE_OPTS.map((s) => (
                <button key={s} className={scaleMode === s ? 'on' : ''} onClick={() => { setScaleMode(s); localStorage.setItem('rf_scale', s); }}>{s}</button>
              ))}
            </div></div>

            <div className="dg"><div className="dg-label">倍速播放</div><div className="dg-row">
              {SPEEDS.map((s) => (
                <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>{speedLabel(s)}</button>
              ))}
            </div></div>

            <div className="dg"><div className="dg-label">音效模式</div><div className="dg-row">
              {AUDIO_OPTS.map((a) => (
                <button key={a} className={audioMode === a ? 'on' : ''} onClick={() => { setAudioMode(a); localStorage.setItem('rf_audio', a); }}>{a}</button>
              ))}
            </div></div>

            <div className="dg"><div className="dg-label">快捷操作</div><div className="dg-quick">
              <button className={introSec ? 'on' : ''} onClick={() => updateSettings({ skipIntro: introSec ? 0 : 12 })}><Icon name="fast-forward" size={22} /><span>片头</span></button>
              <button className={outroSec ? 'on' : ''} onClick={() => updateSettings({ skipOutro: outroSec ? 0 : 15 })}><Icon name="fast-forward" size={22} style={{ transform: 'scaleX(-1)' }} /><span>片尾</span></button>
              <button className={autoPlay ? 'on' : ''} onClick={() => { setAutoPlay((v) => { localStorage.setItem('rf_autoplay', v ? '0' : '1'); return !v; }); }}><Icon name="repeat" size={22} /><span>连播</span></button>
              <button onClick={retry}><Icon name="refresh" size={22} /><span>刷新</span></button>
            </div></div>
          </div>
        </div>
      )}

      {/* 投屏设备列表（真实 DLNA） */}
      {showCast && (
        <CastOverlay
          videoUrl={state.current?.playUrl}
          onClose={() => setShowCast(false)}
          onCast={(d) => setCastDevice(d)}
        />
      )}
    </div>
  );
}

// 弹幕：从源提供的真实弹幕文本数组随机飘屏（无数据则不应被渲染）
function Danmaku({ active, seed, items }: { active: boolean; seed: string; items: string[] }) {
  const [bullets, setBullets] = useState<{ id: number; text: string; top: number; dur: number }[]>([]);
  useEffect(() => {
    setBullets([]);
  }, [seed]);
  useEffect(() => {
    if (!active || items.length === 0) return;
    let n = 0;
    const timer = setInterval(() => {
      const text = items[Math.floor(Math.random() * items.length)];
      const id = Date.now() + n++;
      const top = 6 + Math.random() * 70;
      const dur = 6 + Math.random() * 4;
      setBullets((b) => [...b, { id, text, top, dur }]);
      setTimeout(() => setBullets((b) => b.filter((x) => x.id !== id)), dur * 1000);
    }, 800);
    return () => clearInterval(timer);
  }, [active, seed, items]);

  return (
    <div className="danmaku-layer">
      {bullets.map((b) => (
        <span key={b.id} className="dm" style={{ top: b.top + '%', animationDuration: b.dur + 's' }}>{b.text}</span>
      ))}
    </div>
  );
}
