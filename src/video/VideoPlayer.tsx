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

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

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
  const introDone = useRef(false);
  const appliedStartAt = useRef(false);
  const loadTimer = useRef<number | undefined>(undefined);

  const groups = (detail.raw?.lineGroups as any[] | undefined) ?? [];
  const lines = groups.length || (detail.raw?.lines as number) || 1;
  const progressKey = `${detail.sourceId}:${detail.id}`;
  const perItem = settings.skipByItem[progressKey];
  const introSec = perItem?.intro ?? settings.skipIntro;
  const outroSec = perItem?.outro ?? settings.skipOutro;

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
    ensureResolved(state.current).then((it) => {
      if (!alive || !v) return;
      if (!it.playUrl) {
        setResolving(false);
        setErr('该音源未返回可播放地址，换条线路或换个音源试试。');
        return;
      }
      attachHls(v, it.playUrl, {
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
    if (remain <= outroSec && remain > 0.5) {
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

  const ss = settings.subtitleStyle;
  const cues = localCues.length ? localCues : detail.subtitles?.[0]?.cues;
  const activeCue = settings.enableSubtitle ? getActiveCue(cues, state.progress) : null;

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
    <div className="video-player">
      <div className="vp-stage">
        <video
          ref={videoRef}
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
            if (detail.episodes && episodeIndex < detail.episodes.length - 1) onSelectEpisode(episodeIndex + 1);
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
        <div className="vp-overlay">
          <button className="icon" onClick={onClose} title="返回"><Icon name="x" /></button>
          <div className="vp-title">{detail.title} · {detail.episodes?.[episodeIndex]?.name ?? ''}</div>
          <div className="vp-o-right">
            <button className="icon" onClick={() => setShowCast(true)} title="投屏"><Icon name="cast" /></button>
            <button className="icon" onClick={() => downloadStore.start(detail)} title="下载"><Icon name="download" /></button>
            <button className="icon" onClick={() => setCollapsed(true)} title="收起"><Icon name="chevron-down" /></button>
          </div>
        </div>
      </div>

      <div className="vp-controls">
        <div className="vp-progress">
          <span className="t">{fmtTime(state.progress)}</span>
          <input type="range" min={0} max={state.duration || 0} value={state.progress} onChange={(e) => player.seek(Number(e.target.value))} />
          <span className="t">{fmtTime(state.duration)}</span>
        </div>
        <div className="vp-buttons">
          <button className="icon" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}><Icon name={state.isPlaying ? 'pause' : 'play'} /></button>
          <button className="icon" disabled={episodeIndex <= 0} onClick={() => onSelectEpisode(episodeIndex - 1)} title="上一集"><Icon name="skip-back" /></button>
          <button className="icon" disabled={!detail.episodes || episodeIndex >= detail.episodes.length - 1} onClick={() => onSelectEpisode(episodeIndex + 1)} title="下一集"><Icon name="skip-forward" /></button>
          <select className="vp-speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s === 1 ? '原速' : s + 'x'}</option>)}
          </select>
          {lines > 1 && (
            <div className="vp-lines">
              {Array.from({ length: lines }).map((_, i) => (
                <button key={i} className={'mini' + (i === line ? ' active' : '')} onClick={() => onLineChange(i)}>线路{i + 1}</button>
              ))}
            </div>
          )}
          <button
            className={settings.enableDanmaku ? 'icon active' : 'icon'}
            disabled={!detail.danmaku || detail.danmaku.length === 0}
            onClick={() => updateSettings({ enableDanmaku: !settings.enableDanmaku })}
            title={detail.danmaku && detail.danmaku.length > 0 ? '弹幕开关' : '无弹幕数据（源未提供）'}
          ><Icon name="message" /></button>
          <button
            className={settings.enableSubtitle ? 'icon active' : 'icon'}
            disabled={!cues || cues.length === 0}
            onClick={() => updateSettings({ enableSubtitle: !settings.enableSubtitle })}
            title={cues && cues.length > 0 ? '字幕开关' : '无字幕数据（源未提供或加载外挂）'}
          ><Icon name="captions" /></button>
          <button className="icon" onClick={() => fileRef.current?.click()} title="加载本地字幕(.srt/.vtt)"><Icon name="file-text" /></button>
          <input ref={fileRef} type="file" accept=".srt,.vtt,text/plain" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onLoadSubtitle(f); e.target.value = ''; }} />
          <button className="icon" onClick={() => setShowSubStyle((v) => !v)} title="字幕样式"><Icon name="palette" /></button>
          <button className="icon" onClick={() => setShowSkip((v) => !v)} title="跳过片头片尾（按本剧记忆）"><Icon name="fast-forward" /></button>
          <button className="icon" onClick={onPip} title="画中画"><Icon name="pip" /></button>
          <button className="icon" onClick={onScreenshot} title="截图"><Icon name="camera" /></button>
          <button className="icon" onClick={() => videoRef.current?.requestFullscreen?.()} title="全屏"><Icon name="maximize" /></button>
        </div>
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

      {detail.episodes && detail.episodes.length > 1 && (
        <div className="vp-episodes">
          <span className="vp-ep-title">选集</span>
          <div className="ep-grid">
            {detail.episodes.map((ep, i) => (
              <button key={i} className={'ep-btn' + (i === episodeIndex ? ' active' : '')} onClick={() => onSelectEpisode(i)}>
                {ep.name}
              </button>
            ))}
          </div>
        </div>
      )}

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
