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

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const QUALITIES = ['480P', '720P', '1080P', '4K'];
const DECODE_OPTS: { id: string; label: string }[] = [
  { id: 'system', label: '系统' },
  { id: 'ijk-hard', label: 'IJK硬' },
  { id: 'ijk-soft', label: 'IJK软' },
  { id: 'exo', label: 'Exo' },
];
const SCALE_OPTS = ['默认', '16:9', '4:3', '填充', '原始', '裁剪'];
const AUDIO_OPTS = ['关闭', '影院', '重低音', '环绕', 'HiFi', '人声'];

const speedLabel = (s: number) => (s === 1 ? '1.0x' : s + 'x');

// 解析 .srt / .vtt 字幕为 {time, text} 队列（通用时间戳：HH:MM:SS,mmm 或 HH:MM:SS.mmm）
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
  const fileRef = useRef<HTMLInputElement>(null);
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

  // 新增：播放器专属设置（UI 偏好，持久化到 localStorage）
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [decodeMode, setDecodeMode] = useState<string>(() => localStorage.getItem('rf_decode') || 'exo');
  const [quality, setQuality] = useState<string>(() => localStorage.getItem('rf_quality') || '1080P');
  const [scaleMode, setScaleMode] = useState<string>(() => localStorage.getItem('rf_scale') || '默认');
  const [audioMode, setAudioMode] = useState<string>(() => localStorage.getItem('rf_audio') || '关闭');
  const [autoPlay, setAutoPlay] = useState<boolean>(() => localStorage.getItem('rf_autoplay') !== '0');
  const [landscape, setLandscape] = useState(false);

  const introDone = useRef(false);
  const appliedStartAt = useRef(false);
  const loadTimer = useRef<number | undefined>(undefined);

  const groups = (detail.raw?.lineGroups as any[] | undefined) ?? [];
  const lines = groups.length || (detail.raw?.lines as number) || 1;
  const progressKey = `${detail.sourceId}:${detail.id}`;
  const perItem = settings.skipByItem[progressKey];
  const introSec = perItem?.intro ?? settings.skipIntro;
  const outroSec = perItem?.outro ?? settings.skipOutro;

  // 横屏（移动端）检测：仅窄屏横置时进入沉浸布局，避免桌面端误触发
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape) and (max-width: 900px)');
    const on = () => setLandscape(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // 播放器内浮层接入系统返回手势：先关最上层浮层，再退回上一级
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

  // 切换剧集 / 线路 / 当前曲目：解析并加载（m3u8 走 hls.js），按需恢复进度
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
      // 兜底：8 秒内仍无元数据则判定加载失败
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

  // 倍速记忆
  useEffect(() => { updateSettings({ playbackRate: speed }); }, [speed]);

  // 切换影视/集时清空外挂字幕
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

  // 片尾提前：剩余秒数进入阈值则自动连播下一集
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
      /* 浏览器/WebView 不支持时静默 */
    }
  };

  const onLoadSubtitle = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setLocalCues(parseSubtitle(String(reader.result)));
    reader.readAsText(file);
  };

  // 重试：重新解析并加载当前视频
  const retry = () => {
    setErr(null);
    setResolving(true);
    setRetryNonce((n) => n + 1);
  };

  // 解码模式（Exo 按钮 / 设置抽屉共用）
  const toggleDecode = () => {
    const next = decodeMode === 'exo' ? 'ijk-hard' : 'exo';
    setDecodeMode(next);
    localStorage.setItem('rf_decode', next);
  };
  const decodeLabel = () => {
    if (decodeMode === 'exo') return 'Exo';
    if (decodeMode === 'ijk-hard') return 'Exo·硬';
    return DECODE_OPTS.find((d) => d.id === decodeMode)?.label ?? 'Exo';
  };

  // 倍速 / 画质 循环切换
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

  const toggleFullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  const scrollToEpisodes = () => {
    epRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const ss = settings.subtitleStyle;
  const cues = localCues.length ? localCues : detail.subtitles?.[0]?.cues;
  const activeCue = settings.enableSubtitle ? getActiveCue(cues, state.progress) : null;
  const videoStyle: React.CSSProperties = {
    objectFit: scaleMode === '填充' ? 'fill' : scaleMode === '裁剪' ? 'cover' : 'contain',
  };
  const tags: string[] = Array.isArray(detail.raw?.tags)
    ? (detail.raw!.tags as string[]).slice(0, 5)
    : Array.isArray(detail.raw?.genres)
    ? (detail.raw!.genres as string[]).slice(0, 5)
    : [];

  if (collapsed) {
    return (
      <div className="video-mini-bar" onClick={() => setCollapsed(false)}>
        <span className="vm-thumb" style={{ background: gradientFor(detail.title) }}>{initial(detail.title)}</span>
        <span className="vm-title">{detail.title} · {detail.episodes?.[episodeIndex]?.name}{castDevice ? ` · 投屏到 ${castDevice}` : ''}</span>
        <span className="vm-expand"><Icon name="chevron-down" size={16} /> 展开</span>
      </div>
    );
  }

  return (
    <div className={'video-player' + (landscape ? ' landscape' : '')}>
      <div className="vp-stage" ref={stageRef}>
        <video
          ref={videoRef}
          style={videoStyle}
          controls={false}
          onTimeUpdate={(e) => {
            const v = e.target as HTMLVideoElement;
            player.setProgress(v.currentTime);
            library.setWatchProgress(progressKey, v.currentTime);
            trySkipIntro();
            trySkipOutro();
          }}
          onLoadedMetadata={(e) => player.setDuration((e.target as HTMLVideoElement).duration)}
          onError={() => {
            if (videoRef.current) detachHls(videoRef.current);
            setResolving(false);
            setErr('视频解码失败或地址无效，换个线路试试。');
          }}
          onEnded={() => {
            if (autoPlay && detail.episodes && episodeIndex < detail.episodes.length - 1) onSelectEpisode(episodeIndex + 1);
            else if (detail.episodes && episodeIndex < detail.episodes.length - 1) onSelectEpisode(episodeIndex + 1);
            else player.onEnded();
          }}
        />
        {/* 加载中 / 出错占位，避免黑屏 */}
        {resolving && !err && (
          <div className="vp-loading">
            <div className="vp-spinner" />
            <span>加载中…</span>
          </div>
        )}
        {err && (
          <div className="vp-error">
            <Icon name="x-circle" size={30} />
            <p>{err}</p>
            <button className="mini" onClick={retry}>重试</button>
          </div>
        )}
        {/* 弹幕层：仅当源提供真实弹幕数据且已开启时渲染 */}
        {settings.enableDanmaku && detail.danmaku && detail.danmaku.length > 0 && (
          <Danmaku active={state.isPlaying} seed={detail.id + episodeIndex} items={detail.danmaku} />
        )}
        {/* 字幕层：外挂优先，其次源内嵌；样式可由面板自定义 */}
        {activeCue && (
          <div
            className={`vp-subtitle${ss.position === 'top' ? ' sub-top' : ''}${ss.outline ? ' sub-outline' : ''}${ss.bg ? ' sub-bg' : ''}`}
            style={{ fontSize: ss.size + 'px', color: ss.color } as React.CSSProperties}
          >
            {activeCue}
          </div>
        )}
        {castDevice && <div className="vp-cast-flag"><Icon name="cast" size={14} /> 投屏中：{castDevice}</div>}

        {/* 中央播放键（暂停时显示） */}
        {!state.isPlaying && !resolving && !err && (
          <button className="vp-bigplay" onClick={() => player.toggle()} title="播放"><Icon name="play" size={34} /></button>
        )}

        {/* 顶部浮层 */}
        <div className="vp-top">
          <button className="icon" onClick={onClose} title="返回"><Icon name="arrow-left" /></button>
          <div className="vp-title">{detail.title} · {detail.episodes?.[episodeIndex]?.name ?? ''}</div>
          <div className="vp-o-right">
            <button className="icon" onClick={() => setShowCast(true)} title="投屏"><Icon name="cast" /></button>
            <button className="icon" onClick={() => setCollapsed(true)} title="收起"><Icon name="chevron-down" /></button>
          </div>
        </div>

        {/* 底部控制浮层 */}
        <div className="vp-bottom">
          <div className="vp-progress">
            <span className="t">{fmtTime(state.progress)}</span>
            <input type="range" min={0} max={state.duration || 0} value={state.progress} onChange={(e) => player.seek(Number(e.target.value))} />
            <span className="t">{fmtTime(state.duration)}</span>
          </div>
          <div className="vp-bar">
            <button className="icon big" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}><Icon name={state.isPlaying ? 'pause' : 'play'} /></button>
            <button className="vp-chip" onClick={scrollToEpisodes} title="选集"><Icon name="list" size={16} /><span>选集</span></button>
            <button className="vp-chip" onClick={cycleSpeed} title="倍速">{speedLabel(speed)}</button>
            <button className="vp-chip" onClick={cycleQuality} title="画质">{quality}</button>
            <button
              className={settings.enableDanmaku ? 'vp-chip active' : 'vp-chip'}
              disabled={!detail.danmaku || detail.danmaku.length === 0}
              onClick={() => updateSettings({ enableDanmaku: !settings.enableDanmaku })}
              title={detail.danmaku && detail.danmaku.length > 0 ? '弹幕开关' : '无弹幕数据（源未提供）'}
            ><Icon name="message" size={16} /><span>弹幕</span></button>
            <button className="icon" onClick={toggleFullscreen} title="全屏"><Icon name="maximize" /></button>
          </div>
        </div>
      </div>

      {/* 竖屏信息区 */}
      <div className="vp-info">
        <div className="vp-info-head">
          <div className="vp-poster" style={{ background: gradientFor(detail.title) }}>
            {detail.cover ? <img src={detail.cover} alt="" /> : <Icon name="film" size={30} />}
          </div>
          <div className="vp-meta">
            <div className="vp-name">{detail.title}</div>
            <div className="vp-sub">
              {detail.episodes ? `共 ${detail.episodes.length} 集 · 第 ${episodeIndex + 1} 集` : '正在播放'}
            </div>
            {tags.length > 0 && (
              <div className="vp-tags">
                {tags.map((t, i) => <span key={i} className={'tag' + (i === 0 ? ' hot' : '')}>{t}</span>)}
              </div>
            )}
          </div>
          <button className={'vp-fav' + (faved ? ' on' : '')} onClick={() => setFaved((v) => !v)} title="收藏">
            <Icon name={faved ? 'heart-filled' : 'heart'} size={20} />
          </button>
        </div>

        {/* 4 操作按钮 */}
        <div className="vp-ops">
          <button onClick={() => downloadStore.start(detail)} title="缓存"><Icon name="download" size={20} /><span>缓存</span></button>
          <button className={decodeMode === 'exo' || decodeMode === 'ijk-hard' ? 'on' : ''} onClick={toggleDecode} title="解码（点击切换软/硬解）">
            <Icon name="sliders" size={20} /><span>{decodeLabel()}</span>
          </button>
          <button onClick={() => setShowCast(true)} title="投屏"><Icon name="cast" size={20} /><span>投屏</span></button>
          <button onClick={() => setSettingsOpen(true)} title="播放器设置"><Icon name="settings" size={20} /><span>设置</span></button>
        </div>

        {/* 线路 */}
        {lines > 1 && (
          <div className="vp-lines-row">
            <span className="vp-sec">线路</span>
            <div className="vp-lines">
              {Array.from({ length: lines }).map((_, i) => (
                <button key={i} className={'mini' + (i === line ? ' active' : '')} onClick={() => onLineChange(i)}>线路{i + 1}</button>
              ))}
            </div>
          </div>
        )}

        {/* 选集 */}
        {detail.episodes && detail.episodes.length > 1 && (
          <div className="vp-episodes" ref={epRef}>
            <span className="vp-sec">选集</span>
            <div className="ep-grid">
              {detail.episodes.map((ep, i) => (
                <button key={i} className={'ep-btn' + (i === episodeIndex ? ' active' : '')} onClick={() => onSelectEpisode(i)}>
                  {ep.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 简介 */}
        {detail.raw?.desc && <p className="vp-desc">{String(detail.raw.desc)}</p>}
      </div>

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

      {/* 跳过片头片尾（按本剧记忆） */}
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

      {/* 播放器设置抽屉 */}
      {settingsOpen && (
        <div className="vp-drawer-mask" onClick={() => setSettingsOpen(false)}>
          <div className="vp-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="vp-drawer-handle" />
            <div className="vp-drawer-title">播放器设置</div>

            <div className="vp-group">
              <div className="vp-group-label">解码器</div>
              <div className="seg">
                {DECODE_OPTS.map((d) => (
                  <button key={d.id} className={'seg-item' + (decodeMode === d.id ? ' on' : '')} onClick={() => { setDecodeMode(d.id); localStorage.setItem('rf_decode', d.id); }}>{d.label}</button>
                ))}
              </div>
            </div>

            <div className="vp-group">
              <div className="vp-group-label">画面缩放</div>
              <div className="seg">
                {SCALE_OPTS.map((s) => (
                  <button key={s} className={'seg-item' + (scaleMode === s ? ' on' : '')} onClick={() => { setScaleMode(s); localStorage.setItem('rf_scale', s); }}>{s}</button>
                ))}
              </div>
            </div>

            <div className="vp-group">
              <div className="vp-group-label">倍速播放</div>
              <div className="seg">
                {SPEEDS.map((s) => (
                  <button key={s} className={'seg-item' + (speed === s ? ' on' : '')} onClick={() => setSpeed(s)}>{speedLabel(s)}</button>
                ))}
              </div>
            </div>

            <div className="vp-group">
              <div className="vp-group-label">音效模式</div>
              <div className="seg">
                {AUDIO_OPTS.map((a) => (
                  <button key={a} className={'seg-item' + (audioMode === a ? ' on' : '')} onClick={() => { setAudioMode(a); localStorage.setItem('rf_audio', a); }}>{a}</button>
                ))}
              </div>
            </div>

            <div className="vp-group">
              <div className="vp-group-label">快捷操作</div>
              <div className="vp-quick">
                <button className={'quick' + (introSec ? ' on' : '')} onClick={() => updateSettings({ skipIntro: introSec ? 0 : 12 })}>片头跳过</button>
                <button className={'quick' + (outroSec ? ' on' : '')} onClick={() => updateSettings({ skipOutro: outroSec ? 0 : 15 })}>片尾跳过</button>
                <button className={'quick' + (autoPlay ? ' on' : '')} onClick={() => { setAutoPlay((v) => { localStorage.setItem('rf_autoplay', v ? '0' : '1'); return !v; }); }}>自动连播</button>
                <button className="quick" onClick={retry}>刷新源</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 投屏设备列表 */}
      {showCast && (
        <CastOverlay
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
