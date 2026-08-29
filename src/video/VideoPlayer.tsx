import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlayer, fmtTime, player } from '../lib/playerStore';
import { useMediaResolver } from '../lib/playback';
import { useLibrary } from '../lib/library';
import { AppSettings, useSettings } from '../lib/settings';
import { MediaItem, SourceConfig } from '../engine/types';
import { gradientFor, initial } from '../lib/cover';
import { CastOverlay } from '../components/CastOverlay';
import { downloadStore } from '../lib/downloads';
import { attachHls, detachHls, getLevels, getCurrentLevel, setLevel, type HlsLevel } from '../lib/hlsPlayer';
import { isTauri, saveBlob } from '../lib/tauriBridge';
import { requestOrientation as requestOrientationShared } from '../lib/orientation';
import { Icon } from '../components/Icon';
import { ProxiedImg } from '../components/ProxiedImg';
import { toast } from '../lib/toast';

// ===== 播放器选项（持久化到 localStorage） =====
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
// 解码循环：系统 → 硬解 → 软解 → Exo（文字仅需显示这四个，不带 IJK 前缀）
const DECODE_CYCLE = ['system', 'ijk-hard', 'ijk-soft', 'exo'] as const;
const DECODE_LABEL: Record<string, string> = { system: '系统', 'ijk-hard': '硬解', 'ijk-soft': '软解', exo: 'Exo' };
const QUALITIES = ['480P', '720P', '1080P', '4K'];
const SCALE_OPTS = ['默认', '16:9', '4:3', '填充', '原始', '裁剪'];
// P5：选项 → <video> 的 objectFit
const SCALE_FIT: Record<string, string> = {
  默认: 'contain',
  '16:9': 'cover',
  '4:3': 'cover',
  填充: 'fill',
  原始: 'none',
  裁剪: 'cover',
};
// P5：选项 → 需要锁定的容器宽高比（只有 16:9 / 4:3 两档要改容器）
const SCALE_RATIO: Record<string, string> = { '16:9': '16 / 9', '4:3': '4 / 3' };
// P5-4：设置面板里每个选项的说明，避免再混淆「变形 / 裁边」
const SCALE_HINT: Record<string, string> = {
  默认: '完整显示，不变形不裁切',
  '16:9': '强制 16:9，裁掉多余部分',
  '4:3': '强制 4:3，裁掉多余部分',
  填充: '拉伸铺满，画面会变形',
  原始: '原始像素不放大，四周留白',
  裁剪: '铺满画面，裁掉溢出部分',
};
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
  // 收藏：直接写入library（设计文件 fav-btn 调 toggleFavorite），初始态从 library 派生
  const [faved, setFaved] = useState<boolean>(() => library.isFavorite(detail));
  useEffect(() => { setFaved(library.isFavorite(detail)); }, [library.lib.favorites, detail]);
  // B5 约束：锁定 / 解锁全程不得调用 pause() —— 锁屏只锁操作，不打断播放。
  // 所有涉及 locked 的分支只改 UI 状态（显隐 / 手势拦截），一律不去动 player / video。
  const [locked, setLocked] = useState(false);
  // v3.1.1：小锁独立显隐（不再随整层 .hide 一起消失，解决"点一下锁就没了点不回来"）
  const [lockHidden, setLockHidden] = useState(false);
  const lockTimer = useRef<number | undefined>(undefined);
  const [danmaku, setDanmaku] = useState<boolean>(!!settings.enableDanmaku);
  // 控件显隐：单击切换、播放态 3s 自动隐藏、锁屏强制常显（竖屏/横屏通用）
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<number | undefined>(undefined);
  const [asc, setAsc] = useState(true);
  const [metaExpanded, setMetaExpanded] = useState(false);
  // 横滑快进/快退时间气泡（点播播放窗口左右滑 ±10s）
  const [seekBubble, setSeekBubble] = useState<{ dir: 1 | -1; delta: number; target: number } | null>(null);
  const seekBubbleTimer = useRef<number | undefined>(undefined);
  // 真实分辨率药丸（设计文件 [1920x804]）+ 亮度/音量手势状态
  const [resText, setResText] = useState('');
  const [brightness, setBrightness] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem('rf_brightness') || '');
    return isNaN(v) ? 1 : Math.max(0.1, Math.min(1, v));
  });
  const brightnessRef = useRef(brightness);
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
  // 进度条真实镜像：直接读 <video>.currentTime/duration，不依赖 store 阈值（避免 HLS 下"假进度条"）
  const [liveCur, setLiveCur] = useState(0);
  const [liveDur, setLiveDur] = useState(0);
  const [epOpen, setEpOpen] = useState(false); // ⑦ 横屏选集浮层
  const [ended, setEnded] = useState(false);    // ⑪ 单集/末集播完：重播浮层（B 方案）
  const [pipMode, setPipMode] = useState(false); // ② 进入系统画中画（隐藏控件，纯视频）

  const introDone = useRef(false);
  const appliedStartAt = useRef(false);
  const loadTimer = useRef<number | undefined>(undefined);
  const lastTouchRef = useRef(0); // ③ 触摸结束后抑制随后合成的 click，避免移动端双击被抵消
  const pressTimer = useRef<number | undefined>(undefined); // ⑧ 片头/片尾长按(500ms)开手动输入面板

  const groups = (detail.raw?.lineGroups as any[] | undefined) ?? [];
  const lines = groups.length || (detail.raw?.lines as number) || 1;
  const progressKey = `${detail.sourceId}:${detail.id}`;
  // N1：续播键要带集数 —— 原 progressKey 只到「剧」这一级，同一部剧各集会互相覆盖进度。
  // 片头/片尾设置仍用 progressKey（那是按剧配置的，不该按集拆开）。
  const resumeKey = `${progressKey}:${episodeIndex}`;
  const perItem = settings.skipByItem[progressKey];
  const introSec = perItem?.intro ?? settings.skipIntro;
  const outroSec = perItem?.outro ?? settings.skipOutro;

  // ===== N 组：续播（写入节流 + 加载恢复 + 暂停/切集/退出补写） =====
  const lastSaveRef = useRef(0);
  // 用 ref 持有实现，避免把 library / resumeKey 塞进 useCallback 依赖 ——
  // library 每次渲染都是新对象，一旦进依赖，下面的补写 effect 就会每帧重建并反复写盘，节流形同虚设。
  const saveProgressRef = useRef<(force?: boolean, key?: string) => void>(() => {});
  saveProgressRef.current = (force = false, key?: string) => {
    const v = videoRef.current;
    if (!v || !isFinite(v.currentTime) || v.currentTime <= 0) return;
    const now = Date.now();
    // N4：timeupdate 约 250ms 一次，原来每秒写 4 次 localStorage；这里节流到 5 秒一次。
    // force=true 用于暂停 / 切集 / 退出这类"最后一次机会"的补写（N5），不受节流限制。
    if (!force && now - lastSaveRef.current < 5000) return;
    lastSaveRef.current = now;
    library.setWatchProgress(key || resumeKey, v.currentTime);
    library.setResumeEp(progressKey, episodeIndex); // 记录「看到第几集」，供首页/搜索/历史续播定位
  };
  const saveProgress = useCallback((force = false, key?: string) => saveProgressRef.current(force, key), []);
  // N5：切集 / 切剧 / 关闭播放页时补写一次。
  // cleanup 里的 k 捕获自「上一次渲染」，所以保存的正是旧集（旧剧）的进度，不会串到新集上。
  useEffect(() => {
    const k = resumeKey;
    return () => { saveProgress(true, k); };
  }, [resumeKey, saveProgress]);
  // 记录"这一集已经恢复过进度"，避免 seek 触发的再次 loadedmetadata 重复跳转
  const resumedKeyRef = useRef('');

  // 横屏由用户点「横屏」按钮主动进入（并请求原生真旋转），不再依赖系统传感器自动切换，
  // 避免「点了按钮却不转」的问题。

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

  // 主动请求系统横屏/竖屏（Android 原生桥 window.MuHaiAndroid.setOrientation，由 CI 注入 MainActivity；未注入则退化为 CSS 铺满）
  // X1：改用共享工具，桥未就绪时自动等待最多 1.5s 再调用，解决"有时横屏有时不横"
  const requestOrientation = requestOrientationShared;

  // 屏幕方向：挂载时跟随系统重力感应（竖屏可自动旋转）；进入横屏锁横屏；退出横屏锁竖屏（一下回竖屏）。
  // 不再用 landBySensor 守卫 —— 否则点返回/手势退出时方向 effect 被拦住，原生屏卡在横屏。
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      requestOrientation('sensor');
      return;
    }
    // ① 回退到 v3.1.0 模型：进横屏锁 landscape，退出交还 sensor（跟随重力，可自动翻转/一下回竖屏）
    requestOrientation(landscape ? 'landscape' : 'sensor');
  }, [landscape]);

  // Q18：组件卸载（返回/切走/关页）时强制恢复重力感应自动旋转，避免遗留横屏状态
  useEffect(() => {
    return () => { if (lockTimer.current) window.clearTimeout(lockTimer.current); requestOrientation('sensor'); };
  }, []);

  // 返回手势衔接：先关最上层浮层
  useEffect(() => {
    (window as any).__playerBack = () => {
      if (settingsOpen) { setSettingsOpen(false); return true; }
      if (epOpen) { setEpOpen(false); return true; }
      if (showCast) { setShowCast(false); return true; }
      if (showSubStyle) { setShowSubStyle(false); return true; }
      if (showSkip) { setShowSkip(false); return true; }
      return false;
    };
    return () => { (window as any).__playerBack = undefined; };
  }, [settingsOpen, showCast, showSubStyle, showSkip]);

  // 逐级返回：点播页优先退「横屏 → 竖屏」这一级，否则交还外层（VideoApp 的 closeVideo）
  useEffect(() => {
    const prev = (window as any).__onAndroidBack;
    (window as any).__onAndroidBack = () => {
      // B6：锁定态不要求「先解锁再返回」。先解掉锁，再继续走原本的返回逻辑 ——
      //     横屏锁定：一次返回键同时「解锁 + 退横屏」；竖屏锁定：解锁后直接关闭播放页。
      if (locked) setLocked(false);
      if (landscape) { toggleLandscape(); return false; }
      return typeof prev === 'function' ? prev() : true;
    };
    return () => { (window as any).__onAndroidBack = prev; };
  }, [landscape, locked]);

  // ② 原生画中画状态回调：进入时隐藏控件（纯视频）；退出时回到横屏（小窗全屏钮语义）
  useEffect(() => {
    (window as any).__onPipChanged = (entered: boolean) => {
      setPipMode(!!entered);
      if (entered) { setControlsVisible(false); setLocked(false); }
      else if (!landscape) toggleLandscape();
    };
    return () => { (window as any).__onPipChanged = undefined; };
  }, [landscape]);

  useEffect(() => {
    player.attachVideo(videoRef.current);
    // 进入播放页时读取系统当前亮度/音量作起点（替代默认满亮度/0.9 音量）
    try {
      const sb = (window as any).MuHaiAndroid?.getBrightness?.();
      if (typeof sb === 'number' && !isNaN(sb)) { setBrightness(sb); brightnessRef.current = sb; }
    } catch { /* ignore */ }
    try {
      const sv = (window as any).MuHaiAndroid?.getVolume?.();
      if (typeof sv === 'number' && !isNaN(sv)) { player.setVolume(sv); }
    } catch { /* ignore */ }
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

  // 片尾提前连播（⑥：去掉 autoPlay 前置条件，设了片尾秒数且播到片尾即切下一集）
  const trySkipOutro = () => {
    const v = videoRef.current;
    if (!v || !outroSec || !state.duration) return;
    const remain = state.duration - v.currentTime;
    if (remain <= outroSec && remain > 0.5) {
      if (detail.episodes && episodeIndex < detail.episodes.length - 1) onSelectEpisode(episodeIndex + 1);
      else setEnded(true); // 末集：走 B 方案（重播浮层）
    }
  };

  // ⑧ 片头/片尾「一键设定」：点一下用当前播放进度设定、再点清空；长按(500ms)打开分:秒手动输入面板
  const setSkipOneTap = (which: 'intro' | 'outro') => {
    const v = videoRef.current;
    const t = v ? Math.max(0, Math.floor(v.currentTime)) : 0;
    const cur = which === 'intro' ? introSec : outroSec;
    const next = cur > 0 ? 0 : t; // 已设 → 清空；未设 → 设为当前进度
    const base = settings.skipByItem[progressKey] ?? ({} as { intro?: number; outro?: number });
    updateSettings({
      skipByItem: {
        ...settings.skipByItem,
        [progressKey]: {
          intro: which === 'intro' ? next : (base.intro ?? settings.skipIntro),
          outro: which === 'outro' ? next : (base.outro ?? settings.skipOutro),
        },
      },
    });
    toast(which === 'intro' ? (next > 0 ? `已设片头：${fmtTime(next)}` : '已取消片头') : (next > 0 ? `已设片尾：${fmtTime(next)}` : '已取消片尾'));
  };
  const onSkipDown = (which: 'intro' | 'outro') => () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => { pressTimer.current = undefined; setShowSkip(true); }, 500);
  };
  const onSkipUp = (which: 'intro' | 'outro') => () => {
    if (pressTimer.current) { window.clearTimeout(pressTimer.current); pressTimer.current = undefined; setSkipOneTap(which); }
  };
  const onSkipLeave = () => { if (pressTimer.current) { window.clearTimeout(pressTimer.current); pressTimer.current = undefined; } };

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
    try {
      // ② 原生系统级画中画：点按钮即退出 App、桌面浮 16:9 小窗（A 方案）
      const m = (window as any).MuHaiAndroid;
      if (m && typeof m.enterPip === 'function') { m.enterPip(); return; }
      // 退化（桌面/开发环境未注入原生桥）：用 HTML5 PiP
      const v = videoRef.current;
      if (!v) return;
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
  // ===== S 组：分辨率真实切换（走 HLS 多码率，不再循环假字符串） =====
  // 源本身没有清晰度维度（engine/adapters/normal.ts 只认 $$$ / # / $），
  // 唯一可行路径就是 m3u8 自带的多个码率档位。
  const [levels, setLevels] = useState<HlsLevel[]>([]);
  const [levelOpen, setLevelOpen] = useState(false);
  const refreshLevels = useCallback(() => { setLevels(getLevels(videoRef.current)); }, []);
  // S3：切集 / 换线路 / 重试后档位列表会变，重新读一次并恢复用户选过的档位
  useEffect(() => {
    const t = window.setTimeout(() => {
      const ls = getLevels(videoRef.current);
      setLevels(ls);
      if (ls.length >= 2) {
        const saved = Number(localStorage.getItem('rf_quality_level') ?? '-1');
        if (saved >= -1 && saved < ls.length) setLevel(videoRef.current, saved);
      }
    }, 800);
    return () => window.clearTimeout(t);
  }, [episodeIndex, state.current?.playUrl, retryNonce]);
  // S3：当前档位文案 —— 自动档显示「自动」，手动档显示实际高度
  const qualityLabel = useMemo(() => {
    if (levels.length >= 2) {
      const cur = getCurrentLevel(videoRef.current);
      if (cur < 0) return '自动';
      const l = levels.find((x) => x.index === cur) ?? levels[cur];
      return l?.height ? `${l.height}P` : `档${cur + 1}`;
    }
    return ''; // 单档 / 非 HLS：交给顶栏显示真实分辨率
  }, [levels, levels.length]);
  const cycleQuality = () => {
    const ls = getLevels(videoRef.current);
    setLevels(ls);
    // S2：档位不足两档（单码率 m3u8 或 mp4 直链）时不可切，明确告诉用户为什么
    if (ls.length < 2) { toast('当前片源只有一档，无法切换清晰度'); return; }
    setLevelOpen(true);
  };
  const pickLevel = (index: number) => {
    setLevel(videoRef.current, index);
    localStorage.setItem('rf_quality_level', String(index)); // S3：记住用户的选择
    setLevelOpen(false);
    refreshLevels();
    setControlsVisible(true);
    scheduleHide();
  };
  const cycleAudio = () => {
    const i = AUDIO_OPTS.indexOf(audioMode);
    const n = AUDIO_OPTS[(i + 1) % AUDIO_OPTS.length];
    setAudioMode(n);
    localStorage.setItem('rf_audio', n);
  };

  const toggleLandscape = () => {
    setLandscape((v) => {
      const next = !v;
      // ① 进入横屏锁 landscape；退出交还 sensor（系统重力感应接管，一下回竖屏且恢复自动翻转）
      requestOrientation(next ? 'landscape' : 'sensor');
      return next;
    });
  };

  // 锁屏（点播）：B 组 8 条模型
  // 锁定 = 仅留小锁（其余由 .locked CSS 隐藏）、禁手势、视频继续播；小锁 3 秒后自动隐藏；
  // 锁定态单击只切小锁显隐（onStageTouchEnd 处理）；点锁本身 = 解锁并恢复全部、3 秒后自动隐藏。
  const toggleLock = () => {
    const next = !locked;
    setLocked(next);
    if (lockTimer.current) { window.clearTimeout(lockTimer.current); lockTimer.current = undefined; }
    if (next) {
      setControlsVisible(true); // 锁定态保持控件层渲染（小锁在 .locked 下始终可见），不被 3 秒隐藏整层
      setLockHidden(false);     // 小锁立即出现
      lockTimer.current = window.setTimeout(() => setLockHidden(true), 3000); // B5：3 秒后自动隐藏
    } else {
      setLockHidden(false);
      setControlsVisible(true); // B8：解锁恢复全部控件
      if (state.isPlaying) scheduleHide(); // B8：3 秒后自动隐藏
    }
  };

  const toggleFullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  const scrollToEpisodes = () => epRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // ③ 单击/双击：移动端统一走 touch 路径（onStageTouchEnd），这里只在「非触摸」(桌面鼠标)时生效。
  // 触摸结束后 700ms 内的合成 click 一律忽略，避免移动端一次点按被 click+touch 双重触发导致 toggle 抵消。
  const onStageClick = () => {
    if (locked) { setLockHidden((v) => !v); return; }
    if (Date.now() - lastTouchRef.current < 700) return;
    toggleControls();
  };

  // 手势：竖滑 左半=亮度 / 右半=音量；横滑=进度快进/快退（点播）。方向区分互不冲突。
  const showHud = (type: 'bright' | 'vol', value: number) => {
    setHud({ type, value });
    if (hudTimer.current) window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setHud(null), 800);
  };
  const SWIPE_STEP = 5; // 每跨 40px 跳 5s
  const SWIPE_EDGE = 40; // 左边缘 40px 内右滑 = 返回
  const onStageTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const el = stageRef.current as any;
    if (!el) return;

    // B12：触摸落在控件（按钮 / 播放图标 / 进度条）上时，把手势让给控件本身 ——
    // 既不 preventDefault（否则会把按钮的 click 一起吞掉，点小锁没反应），
    // 也不初始化手势状态（否则点一下按钮还会顺带触发一次「控件显隐」）。
    const hitControl = !!(e.target as HTMLElement | null)?.closest?.('button, .play-ico, .bar, input, a');
    if (hitControl) { el.__sx = null; el.__moved = true; return; }

    // 阻止默认行为，避免移动端 touch 后触发 ghost click（否则单击显隐会被 click 再触发一次抵消）
    try { e.preventDefault(); } catch { /* ignore */ }
    el.__sx = t.clientX;
    el.__sy = t.clientY;
    el.__accum = 0;
    el.__dir = 0;
    el.__backing = false;
    el.__ts = Date.now();        // 轻触起始时间
    el.__moved = false;          // 是否发生滑动
    // B11：锁定态仍要记录轻触起点（供「单击切小锁显隐」判定），
    //      但不初始化亮度/音量基准、也不允许滑动 —— 滑动由 onStageTouchMove 的 locked 分支继续拦。
    if (locked) return;
    el.__half = t.clientX < window.innerWidth / 2 ? 'left' : 'right';
    el.__bStart = brightnessRef.current;
    // T5：手势起点用「系统当前音量」（不是 video 的乘数）。从系统当前值接着调，不回 100。
    el.__vStart = systemVolRef.current;
  };
  const onStageTouchMove = (e: React.TouchEvent) => {
    const el = stageRef.current as any;
    if (el == null || el.__sx == null || locked) return;
    const t = e.touches[0];
    const dx = t.clientX - el.__sx;
    const dy = t.clientY - el.__sy;
    if (el.__sx <= SWIPE_EDGE && dx > 60 && Math.abs(dy) < 80) { el.__backing = true; return; }
    if (el.__backing) return;
    if (Math.abs(dx) >= 10 || Math.abs(dy) >= 10) el.__moved = true; // 标记发生滑动
    if (Math.abs(dx) < 16 && Math.abs(dy) < 16) return; // 死区
    if (Math.abs(dy) > Math.abs(dx)) {
      // 竖向：左半亮度 / 右半音量
      const start = el.__half === 'left' ? el.__bStart : el.__vStart;
      const val = Math.max(0, Math.min(1, start + (-dy) / 320));
      if (el.__half === 'left') {
        const b = Math.round(val * 100) / 100;
        setBrightness(b);
        brightnessRef.current = b;
        try { localStorage.setItem('rf_brightness', String(b)); } catch { /* ignore */ }
        try { (window as any).MuHaiAndroid?.setBrightness?.(b); } catch { /* ignore */ }
        showHud('bright', Math.round(val * 100));
      } else {
        // T5：只调系统音量；video.volume 恒为 1、muted 恒为 false，不做双轨相乘
        try { (window as any).MuHaiAndroid?.setVolume?.(val); } catch { /* ignore */ }
        systemVolRef.current = val;
        showHud('vol', Math.round(val * 100));
      }
      el.__accum = dy;
    } else {
      // 横向：点播进度快进/快退
      const dir = dx > 0 ? 1 : dx < 0 ? -1 : el.__dir;
      const stepPx = 40;
      const crossed = Math.floor(Math.abs(dx) / stepPx) - Math.floor(Math.abs(el.__accum) / stepPx);
      if (crossed > 0 && dir !== 0) {
        // 用 <video> 真实 currentTime 做基准（避免闭包里 state.progress 滞后导致跳 0）；
        // duration 未就绪（HLS 初期常 NaN/0）时直接跳过，避免 currentTime 被 clamp 到 0 重头播放。
        const v = videoRef.current;
        const cur = v ? v.currentTime : state.progress;
        const d = v && isFinite(v.duration) && v.duration > 0 ? v.duration : (state.duration || 0);
        if (d <= 0) return;
        const target = Math.max(0, Math.min(d, cur + dir * SWIPE_STEP * crossed));
        if (v) v.currentTime = target;
        player.seek(target); // 同时更新 state.duration/progress，驱动 .fill 实时变化
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
      // 轻触判定：未发生滑动 + 时长 < 250ms = 一次轻触（用于单击显隐 / 双击暂停）
      const dt = Date.now() - (el.__ts || 0);
      const isTap = !el.__moved && !el.__backing && dt < 250 && el.__sx != null;
      if (isTap) {
        // B11：锁定态走独立分支 —— 双击暂停已禁用，没必要再等 280ms 判双击；
        //      单击立即切换显隐（锁定态由 CSS 保证只有小锁可见，所以等于只切小锁）
        if (locked) {
          if (tapTimer.current) { window.clearTimeout(tapTimer.current); tapTimer.current = undefined; }
          setLockHidden((v) => !v);
        } else if (epOpen) {
          setEpOpen(false); // ⑦ 横屏选集浮层：点播放窗口空白即关
        } else if (settingsOpen) {
          setSettingsOpen(false); // ⑨ 横屏设置侧栏：点空白即关
        } else if (showCast) {
          setShowCast(false);
        } else if (showSkip) {
          setShowSkip(false);
        } else if (tapTimer.current) {
          // 第二击 = 双击：播放/暂停。
          // M1/M2：绝不改变控件显隐 —— 恢复成第一击之前的样子（隐藏态双击不会把控件弹出来）
          window.clearTimeout(tapTimer.current);
          tapTimer.current = undefined;
          const wasVisible = el.__tapVisible !== false;
          player.toggle();
          setControlsVisible(wasVisible);
          if (wasVisible && state.isPlaying) scheduleHide();
        } else {
          // 第一击：记下「双击前控件是否可见」，存到 DOM 元素上（不受后续 re-render 影响）
          const wasVisible = controlsVisible;
          el.__tapVisible = wasVisible;
          // K3：控件当前是隐藏的 → 第一下就立即唤出，不再干等 280ms
          if (!wasVisible) { setControlsVisible(true); if (state.isPlaying) scheduleHide(); }
          // 单击语义仍由 280ms 定时器兜底：原本可见 → 到点隐藏；原本隐藏 → K3 已处理，到点不动
          tapTimer.current = window.setTimeout(() => {
            tapTimer.current = undefined;
            if (wasVisible) setControlsVisible(false);
          }, 280);
        }
      }
      if (el.__backing) {
        if (settingsOpen) setSettingsOpen(false);
        else if (showCast) setShowCast(false);
        else if (showSubStyle) setShowSubStyle(false);
        else if (showSkip) setShowSkip(false);
        else if (landscape) toggleLandscape();
        else onClose();
      }
      el.__sx = null; el.__sy = null; el.__accum = 0; el.__dir = 0; el.__backing = false; el.__half = null; el.__moved = false; el.__ts = 0;
      lastTouchRef.current = Date.now(); // ③ 抑制随后合成的 click
    }
  };
  const tapTimer = useRef<number | undefined>(undefined);
  // K2：清掉可能残留的单击/双击定时器。
  // 场景 —— 先点一下空白（起了 280ms 定时器），紧接着点某个控件按钮：
  // 按钮动作执行完之后，迟到的定时器才到点，又把控件显隐翻一次，
  // 表现就是"控件自己莫名其妙藏起来 / 弹出来"。
  // 用 touchstart 捕获阶段挂在 overlay 上：既早于 touchend（不会误清本次新起的定时器），
  // 又能一次性覆盖 overlay 内的所有按钮（含横屏底部 10 个工具键）。
  const clearTapTimer = useCallback(() => {
    if (tapTimer.current) { window.clearTimeout(tapTimer.current); tapTimer.current = undefined; }
  }, []);
  // 单击切换控件显隐；播放态 3s 后自动隐藏；锁屏强制常显（竖屏/横屏通用）
  const scheduleHide = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    // B9：去掉 locked —— 锁定态也要启动 3 秒定时器，让小锁自动隐藏（此前小锁永远亮着）
    if (!state.isPlaying) return;
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 3000);
  };
  const toggleControls = () => {
    setControlsVisible((v) => {
      const next = !v;
      if (next) scheduleHide();
      return next;
    });
  };
  // B7+B9：锁定/解锁都要走这里 —— 锁定瞬间先让小锁亮起，3 秒后被 scheduleHide 藏掉；
  //        解锁时控件立刻出现并重启 3 秒倒计时。
  useEffect(() => {
    setControlsVisible(true);
    if (state.isPlaying) scheduleHide();
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
  // P5：6 个选项各自落到「objectFit + 容器比例」的组合（此前 16:9 / 4:3 / 原始 是死选项，点了跟默认一样）
  //   默认  contain  完整显示，不变形不裁切（默认档保持不变，见 P5-5）
  //   16:9  锁 16/9 容器 + cover  强制按 16:9 呈现，靠裁切实现，不变形
  //   4:3   锁 4/3 容器 + cover  同上
  //   填充  fill                 拉伸铺满，画面**会变形**（人会变矮胖）
  //   原始  none                 1:1 像素不放大，居中显示，四周留白
  //   裁剪  cover                铺满容器，裁掉溢出部分，不变形
  const videoStyle: React.CSSProperties = {
    objectFit: (SCALE_FIT[scaleMode] ?? 'contain') as React.CSSProperties['objectFit'],
    objectPosition: 'center', // P5-2：「原始」不放大时居中
    filter: brightness < 1 ? `brightness(${brightness})` : undefined,
  };
  // 需要锁容器比例的两档；其余档保持容器原样（竖屏 16:9 / 横屏全屏）
  const lockRatio = SCALE_RATIO[scaleMode] || '';
  const tags: string[] = Array.isArray(detail.raw?.tags)
    ? (detail.raw!.tags as string[]).slice(0, 5)
    : Array.isArray(detail.raw?.genres)
    ? (detail.raw!.genres as string[]).slice(0, 5)
    : [];
  const vr = detail.raw as any;
  const filmYear = vr?.vod_year || vr?.year;
  const director = vr?.vod_director || vr?.director;
  const actor = vr?.vod_actor || vr?.actor;
  const statusTag = /完结/.test(vr?.vod_remarks || '') ? '完结' : /连载/.test(vr?.vod_remarks || '') ? '连载中' : '';
  // Q5：无数据时保底标签，避免该行空着（年份/类型占位 或 固定 HD）
  const hasAnyTag = !!statusTag || tags.length > 0 || quality === '4K' || audioMode !== '关闭';
  const fallbackTags: string[] = hasAnyTag ? [] : [(filmYear ? String(filmYear) : '影视'), 'HD'];

  const epName = detail.episodes?.[episodeIndex]?.name ?? `第${episodeIndex + 1}集`;

  // ===== T 组：缓冲状态 =====
  const [buffering, setBuffering] = useState(false);
  const [bufPct, setBufPct] = useState(0);
  const bufferingTimer = useRef<number | undefined>(undefined);
  // T3：缓冲转圈延迟 300ms —— 快进后 200ms 内缓冲好就不显示，避免一闪而过反而像卡顿
  const markBuffering = useCallback(() => {
    if (bufferingTimer.current) window.clearTimeout(bufferingTimer.current);
    bufferingTimer.current = window.setTimeout(() => setBuffering(true), 300);
  }, []);
  const clearBuffering = useCallback(() => {
    if (bufferingTimer.current) { window.clearTimeout(bufferingTimer.current); bufferingTimer.current = undefined; }
    setBuffering(false);
  }, []);
  // T5：进入播放器时读系统当前音量作为手势起点（"从系统当前音量接着调，不是回到 100"）
  const systemVolRef = useRef(1);
  useEffect(() => {
    try { const v = (window as any).MuHaiAndroid?.getVolume?.(); if (typeof v === 'number') systemVolRef.current = v; } catch { /* ignore */ }
    if (videoRef.current) { videoRef.current.volume = 1; videoRef.current.muted = false; } // 视频音量恒为 1，不做乘数
  }, []);

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
        // P5-1/P5-3：竖屏直接改容器比例；横屏容器是 fixed 全屏，比例交给 .screen 锁（见下）
        style={!landscape && lockRatio ? { aspectRatio: lockRatio } : undefined}
        onTouchStart={onStageTouchStart}
        onTouchMove={onStageTouchMove}
        onTouchEnd={onStageTouchEnd}
      >
        <div className={'screen' + (landscape && lockRatio ? ' locked-ratio' : '')} style={landscape && lockRatio ? { aspectRatio: lockRatio } : undefined}>
          <div className="poster" />
          <video
            ref={videoRef}
            style={videoStyle}
            controls={false}
            onClick={onStageClick}
            // N5：暂停时立刻补写一次进度（不然要等满 5 秒才落盘）
            onPause={() => saveProgress(true)}
            // T3：缓冲开始 → 延迟 300ms 显示转圈；播放/可播/seek 完成 → 立即取消
            onWaiting={() => markBuffering()}
            onStalled={() => markBuffering()}
            onSeeking={() => markBuffering()}
            onPlaying={clearBuffering}
            onCanPlay={clearBuffering}
            onSeeked={() => { saveProgress(true); clearBuffering(); }}
            onTimeUpdate={(e) => {
              const v = e.target as HTMLVideoElement;
              setLiveCur(v.currentTime);
              setLiveDur(v.duration || 0);
              player.setProgress(v.currentTime);
              // T4：已缓冲进度 = buffered 末尾 / 总时长（reused 现有 250ms 周期，不必另开定时器）
              try {
                if (v.buffered.length && v.duration > 0) {
                  const end = v.buffered.end(v.buffered.length - 1);
                  setBufPct(Math.min(100, (end / v.duration) * 100));
                }
              } catch { /* ignore */ }
              saveProgress(); // N4：内部 5 秒节流
              trySkipIntro();
              trySkipOutro();
            }}
            onLoadedMetadata={(e) => {
              const v = e.target as HTMLVideoElement;
              setLiveDur(v.duration || 0);
              player.setDuration(v.duration);
              if (v.videoWidth && v.videoHeight) setResText(`${v.videoWidth}x${v.videoHeight}`);
              // N1/N2/N3：续播 —— 上次看到哪儿就接着播
              const d = v.duration || 0;
              if (d > 0 && resumedKeyRef.current !== resumeKey) {
                resumedKeyRef.current = resumeKey;
                const saved = library.lib.watchProgress[resumeKey] ?? 0;
                // N3：超过 95% 视为已看完 → 从头播，避免一打开就跳到片尾
                // N1：不足 30 秒的进度不值得恢复（可能是误触），也从头播
                if (saved > 30 && saved < d * 0.95) {
                  v.currentTime = saved;
                  setLiveCur(saved);
                  player.seek(saved);
                  toast(`上次看到 ${fmtTime(saved)}，已为你续播`); // N2
                }
              }
            }}
            onDurationChange={(e) => { const v = e.target as HTMLVideoElement; setLiveDur(v.duration || 0); }}
            onError={() => {
              if (videoRef.current) detachHls(videoRef.current);
              setResolving(false);
              setErr('视频解码失败或地址无效，换个线路试试。');
            }}
            onEnded={() => {
              if (detail.episodes && episodeIndex < detail.episodes.length - 1) onSelectEpisode(episodeIndex + 1);
              else {
                setEnded(true); // ⑪ B 方案：单集/末集播完 → 重播浮层（不再调音乐 store 的 onEnded）
                if (landscape) toggleLandscape(); // 横屏则自动退回竖屏播放页
              }
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
          {/* 锁屏态隐藏投屏提示（B1：锁定后除小锁外不留任何浮层） */}
          {castDevice && !locked && <div className="vp-cast-flag"><Icon name="cast" size={14} /> 投屏中：{castDevice}</div>}

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
            <div className={'overlay' + (controlsVisible ? '' : ' hide') + (locked ? ' locked' : '') + (resolving && !err ? ' loading' : '')} onTouchStartCapture={clearTapTimer}>
              <div className="top">
                <button className="back" onClick={onClose} title="返回"><Icon name="arrow-left" size={18} /></button>
                <div className="ttl">
                  <span className="name">{detail.title} · {epName}</span>
                  <span className="res">[{qualityLabel || resText || '1920x804'}]</span>
                </div>
                <div className="acts">
                  <button className={'icon lock-btn' + (locked ? ' on' : '') + (lockHidden ? ' lock-hidden' : '')} onClick={() => toggleLock()} title={locked ? '已锁定' : '锁定屏幕'}><Icon name={locked ? 'lock' : 'lock-open'} size={16} /></button>
                  <button className={'icon' + (danmaku ? ' on' : '')} onClick={toggleDanmaku} disabled={!detail.danmaku || detail.danmaku.length === 0} title={danmaku ? '弹幕开' : '弹幕关'}><Icon name="message" size={16} /></button>
                </div>
              </div>
              <div className="center">
                <button className="big-btn" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}>
                  {/* T3：缓冲转圈与播放键原地合体 —— 同一圆圈同一位置，只换里面内容 */}
                  {buffering ? <span className="vp-spinner" /> : <Icon name={state.isPlaying ? 'pause' : 'play'} size={30} />}
                </button>
              </div>
              <div className="bottom">
                <span className="play-ico" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}><Icon name={state.isPlaying ? 'pause' : 'play'} size={18} /></span>
                <div className="bar" onClick={(e) => {
                  const v = videoRef.current; if (!v || !liveDur) return;
                  const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                  v.currentTime = ratio * liveDur; setLiveCur(v.currentTime); player.seek(v.currentTime);
                }}>
                  {/* T4：已缓冲进度（浅色），复用 onTimeUpdate 兜底刷新，层级介于轨道与已播放之间 */}
                  <div className="buffered" style={{ width: `${bufPct}%` }} />
                  <div className="fill" style={{ width: `${liveDur ? (liveCur / liveDur) * 100 : 0}%` }} />
                </div>
                <button className="land" onClick={toggleLandscape} title="横屏"><Icon name="rotate" size={18} /></button>
              </div>
            </div>
          )}

          {/* ============ 横屏：水平布局（对齐视频播放器UI.html：顶栏 + 左右边栏 + 中央水平播放控制 + 底部进度条 + 底部横排工具） ============ */}
          {landscape && (
            <div className={'overlay land-h' + (controlsVisible ? '' : ' hide') + (locked ? ' locked' : '') + (resolving && !err ? ' loading' : '')} onTouchStartCapture={clearTapTimer}>
              {/* 顶栏：返回 / 标题 / 状态时钟电量 */}
              <div className="land-top">
                <button className="back" onClick={toggleLandscape} title="返回"><Icon name="arrow-left" size={18} /></button>
                <div className="ttl">
                  <span className="name">{detail.title}</span>
                  <span className="res">· 第{episodeIndex + 1}集 · [{qualityLabel || resText || '1920x804'}]</span>
                </div>
                <div className="status">
                  <Icon name="clock" size={15} />
                  <Icon name="battery" size={16} />
                  <span>{clock}</span>
                </div>
              </div>

              {/* 左侧边栏：锁 / 弹幕 */}
              <div className="side left">
                <button className={'icon lock-btn' + (locked ? ' on' : '') + (lockHidden ? ' lock-hidden' : '')} onClick={() => toggleLock()} title={locked ? '已锁定' : '锁定屏幕'}><Icon name={locked ? 'lock' : 'lock-open'} size={20} /></button>
                <button className={'icon' + (danmaku ? ' on' : '')} onClick={toggleDanmaku} disabled={!detail.danmaku || detail.danmaku.length === 0} title={danmaku ? '弹幕开' : '弹幕关'}><Icon name="message" size={20} /></button>
              </div>

              {/* 右侧边栏：投屏 / 画中画 */}
              <div className="side right">
                <button className="icon" onClick={(e) => { e.stopPropagation(); setShowCast(true); }} title="投屏"><Icon name="tv" size={20} /></button>
                <button className="icon" onClick={(e) => { e.stopPropagation(); onPip(); }} title="画中画"><Icon name="pip" size={20} /></button>
              </div>

              {/* 中央水平播放控制：上一集 / 播放 / 下一集 */}
              <div className="center">
                <button className="ctrl" onClick={() => episodeIndex > 0 && onSelectEpisode(episodeIndex - 1)} title="上一集"><Icon name="prev" size={26} /></button>
                <button className="ctrl main" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}>
                  {/* T3：横屏主播放键同样与转圈合体，左右切集键保持可点 */}
                  {buffering ? <span className="vp-spinner" /> : <Icon name={state.isPlaying ? 'pause' : 'play'} size={32} />}
                </button>
                <button className="ctrl" onClick={() => detail.episodes && episodeIndex < detail.episodes.length - 1 && onSelectEpisode(episodeIndex + 1)} title="下一集"><Icon name="next" size={26} /></button>
              </div>

              {/* 底部：横向进度条 + 横排 10 工具按钮 */}
              <div className="bottom">
                <div className="prow">
                  <span className="pi" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}><Icon name={state.isPlaying ? 'pause' : 'play'} size={18} /></span>
                  <span className="t">{fmtTime(liveCur)}</span>
                  <div className="bar" onClick={(e) => {
                    const v = videoRef.current; if (!v || !liveDur) return;
                    const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                    v.currentTime = ratio * liveDur; setLiveCur(v.currentTime); player.seek(v.currentTime);
                  }}>
                    <div className="buffered" style={{ width: `${bufPct}%` }} />
                  <div className="fill" style={{ width: `${liveDur ? (liveCur / liveDur) * 100 : 0}%` }} />
                  </div>
                  <span className="t">{fmtTime(liveDur)}</span>
                  <button className="land" onClick={toggleLandscape} title="退出横屏"><Icon name="rotate" size={18} /></button>
                </div>
                <div className="tools">
                  <button className={'tool' + (DECODE_CYCLE.indexOf(decodeMode as any) >= 0 ? ' on' : '')} onClick={toggleDecode}><Icon name="sliders" size={15} /><span>解码</span></button>
                  <button className="tool" onClick={retry}><Icon name="refresh" size={15} /><span>刷新</span></button>
                  <button className="tool" onClick={() => { const v = videoRef.current; if (v) { v.currentTime = 0; v.play().catch(() => {}); } }}><Icon name="replay" size={15} /><span>重播</span></button>
                  <button className="tool" onClick={() => setShowSubStyle(true)}><Icon name="captions" size={15} /><span>字幕</span></button>
                  <button className={'tool' + (introSec ? ' on' : '')} onPointerDown={onSkipDown('intro')} onPointerUp={onSkipUp('intro')} onPointerLeave={onSkipLeave} onPointerCancel={onSkipLeave}><Icon name="skip-forward" size={15} /><span>片头</span></button>
                  <button className={'tool' + (outroSec ? ' on' : '')} onPointerDown={onSkipDown('outro')} onPointerUp={onSkipUp('outro')} onPointerLeave={onSkipLeave} onPointerCancel={onSkipLeave}><Icon name="skip-back" size={15} /><span>片尾</span></button>
                  <button className={'tool' + (audioMode !== '关闭' ? ' on' : '')} onClick={cycleAudio}><Icon name="volume" size={15} /><span>音效</span></button>
                  {/* S2：单码率片源（levels.length === 1）置灰并显示「单档」，让用户知道不是按钮坏了 */}
                  <button className="tool" onClick={cycleQuality} disabled={levels.length === 1}
                    title={levels.length === 1 ? '当前片源只有一档' : '选择清晰度'}>
                    <Icon name="sparkles" size={15} /><span>{levels.length === 1 ? '单档' : (qualityLabel || '画质')}</span>
                  </button>
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
                <div className={'meta-extra' + (metaExpanded ? ' open' : '')}>
                  {director && <><span className="label">导演</span> {director}　</>}
                  {actor && <><span className="label">主演</span> {actor}</>}
                </div>
                {(director || actor) && (
                  <button className="meta-toggle" onClick={() => setMetaExpanded((v) => !v)}>{metaExpanded ? '收起 ▴' : '展开 ▾'}</button>
                )}
              </div>
              <button className={'fav-btn' + (faved ? ' on' : '')} onClick={() => { library.toggleFavorite(detail); setFaved(library.isFavorite(detail)); }}>
                <Icon name={faved ? 'heart-filled' : 'heart'} size={14} />{faved ? '已收藏' : '加入收藏'}
              </button>
            </div>
          </div>

          <div className="tags">
            {statusTag && <span className="hot">{statusTag}</span>}
            {tags.map((t, i) => <span key={'g' + i}>{t}</span>)}
            {fallbackTags.map((t, i) => <span key={'fb' + i}>{t}</span>)}
            {quality === '4K' && <span className="hot">4K</span>}
            {audioMode !== '关闭' && <span>杜比音效</span>}
          </div>

          {/* 4 操作按钮（缓存/解码/投屏/设置）— 占位展示，待用户确认哪些要接 */}
          <div className="actions">
            <button onClick={() => downloadStore.start(detail)} title="缓存"><span className="circle"><Icon name="download" size={24} /></span>缓存</button>
            <button className={DECODE_CYCLE.indexOf(decodeMode as any) >= 0 ? 'on' : ''} onClick={toggleDecode} title="解码/音效"><span className="circle"><Icon name="sliders" size={24} /></span>系统</button>
            <button onClick={() => setShowCast(true)} title="投屏"><span className="circle"><Icon name="tv" size={24} /></span>投屏</button>
            <button onClick={() => setSettingsOpen(true)} title="播放器设置"><span className="circle"><Icon name="settings" size={24} /></span>设置</button>
          </div>

          {lines > 0 && (
            <div className="section">
              <div className="sec-head"><span className="sec-title">线路</span><span className="sec-more" onClick={() => {}}>自动选速 &gt;</span></div>
              <div className="line-row">
                {Array.from({ length: lines }).map((_, i) => (
                  <button key={i} className={i === line ? 'active' : ''} onClick={() => onLineChange(i)}>{LINE_NAMES[i] ?? `线路${i + 1}`}</button>
                ))}
              </div>
            </div>
          )}

          {detail.episodes && detail.episodes.length > 0 && (
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

      {/* S2 · 清晰度档位选择：多码率 m3u8 才出现，选中即刻生效 */}
      {levelOpen && (
        <div className="vp-panel">
          <div className="vp-panel-head">选择清晰度
            <button className="link" onClick={() => setLevelOpen(false)}>关闭</button>
          </div>
          <div className="vp-levels">
            <button
              className={getCurrentLevel(videoRef.current) < 0 ? 'on' : ''}
              onClick={() => pickLevel(-1)}
            >自动{getCurrentLevel(videoRef.current) < 0 ? '（当前）' : ''}</button>
            {levels.map((l) => (
              <button
                key={l.index}
                className={getCurrentLevel(videoRef.current) === l.index ? 'on' : ''}
                onClick={() => pickLevel(l.index)}
              >
                {l.height ? `${l.height}P` : `档位 ${l.index + 1}`}
                {l.bitrate ? <span className="sub">{Math.round(l.bitrate / 1000)} kbps</span> : null}
              </button>
            ))}
          </div>
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
            {/* P5-4：当前所选档位的说明，避免再混淆「会不会变形 / 会不会裁边」 */}
            <div className="dg-hint">{SCALE_HINT[scaleMode] || SCALE_HINT['默认']}</div>

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

            {!landscape && (
            <div className="dg"><div className="dg-label">快捷操作</div><div className="dg-quick">
              <button className={introSec ? 'on' : ''} onPointerDown={onSkipDown('intro')} onPointerUp={onSkipUp('intro')} onPointerLeave={onSkipLeave} onPointerCancel={onSkipLeave}><Icon name="fast-forward" size={22} /><span>片头</span></button>
              <button className={outroSec ? 'on' : ''} onPointerDown={onSkipDown('outro')} onPointerUp={onSkipUp('outro')} onPointerLeave={onSkipLeave} onPointerCancel={onSkipLeave}><Icon name="fast-forward" size={22} style={{ transform: 'scaleX(-1)' }} /><span>片尾</span></button>
              <button className={autoPlay ? 'on' : ''} onClick={() => { setAutoPlay((v) => { localStorage.setItem('rf_autoplay', v ? '0' : '1'); return !v; }); }}><Icon name="repeat" size={22} /><span>连播</span></button>
              <button onClick={retry}><Icon name="refresh" size={22} /><span>刷新</span></button>
            </div></div>
            )}
          </div>
        </div>
      )}

      {/* ⑦ 横屏选集浮层：点选集弹出，点集切换；点遮罩/播放窗口空白关闭 */}
      {epOpen && (
        <div className="ep-mask" onClick={() => setEpOpen(false)}>
          <div className="ep-panel" onClick={(e) => e.stopPropagation()}>
            <div className="ep-head">
              <span>选集</span>
              <span className="ep-toggle" onClick={() => setAsc((v) => !v)}>{asc ? '正序 ▾' : '倒序 ▴'}</span>
            </div>
            <div className="ep-grid">
              {(() => {
                const list = detail.episodes ?? [];
                const order = asc ? list.map((_, i) => i) : list.map((_, i) => list.length - 1 - i);
                return order.map((i) => {
                  const ep = list[i];
                  return (
                    <button key={i} className={(i === episodeIndex ? 'active' : '') + (ep?.locked ? ' locked' : '')} onClick={() => { onSelectEpisode(i); setEpOpen(false); }}>{ep?.locked ? '锁' : (ep?.name ?? `第${i + 1}集`)}</button>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ⑪ 单集/末集播完：重播浮层（B 方案）—— 停最后一帧 + 中间浮重播按钮 */}
      {ended && (
        <div className="vp-ended" onClick={() => setEnded(false)}>
          <div className="vp-ended-inner" onClick={(e) => e.stopPropagation()}>
            <button className="replay-btn" onClick={() => {
              const v = videoRef.current;
              if (v) { v.currentTime = 0; v.play().catch(() => {}); }
              setEnded(false);
            }}><Icon name="replay" size={26} /><span>重播</span></button>
            <button className="mini" onClick={() => setEnded(false)}>关闭</button>
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
