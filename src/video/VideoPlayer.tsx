import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlayer, fmtTime, player } from '../lib/playerStore';
import { useMediaResolver } from '../lib/playback';
import { useLibrary } from '../lib/library';
import { AppSettings, updateSettingsGlobal } from '../lib/settings';
import { MediaItem, SourceConfig } from '../engine/types';
import { gradientFor, initial } from '../lib/cover';
import { CastOverlay } from '../components/CastOverlay';
import { downloadStore } from '../lib/downloads';
import { attachHls, detachHls, getLevels, getCurrentLevel, setLevel, type HlsLevel } from '../lib/hlsPlayer';
import { isTauri, saveBlob } from '../lib/tauriBridge';
import { requestOrientation as requestOrientationShared, requestImmersive, pipBridgeReady } from '../lib/orientation';
import { Icon } from '../components/Icon';
import { ProxiedImg } from '../components/ProxiedImg';
import { toast } from '../lib/toast';
import { useSources } from '../store';
import { crossSourceCover, cachedCrossCover, tryCoverFallback } from '../lib/crossCover';
import { pushBackHandler } from '../lib/backStack';

// V3.3.6 八·二：子站无 logo 时的六边形兜底图案（白色描边六边形 + 源名 hash 固定配色，同源同色）
const SUBSITE_PALETTE: [string, string][] = [
  ['#3b82f6', '#2563eb'], ['#a855f7', '#7c3aed'], ['#06b6d4', '#0891b2'], ['#10b981', '#059669'],
  ['#f97316', '#ea580c'], ['#ef4444', '#dc2626'], ['#ec4899', '#db2777'], ['#6366f1', '#4f46e5'],
  ['#f59e0b', '#d97706'], ['#14b8a6', '#0d9488'], ['#e11d48', '#be123c'], ['#0ea5e9', '#0284c7'],
];
const subsiteColor = (name: string): string => {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  const [a, b] = SUBSITE_PALETTE[Math.abs(h) % SUBSITE_PALETTE.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
};

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
  detailLoading = false,
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
  detailLoading?: boolean; // V3.3.0 #6：详情后台解析中（选集/介绍显示骨架）
  onLineChange: (i: number) => void;
  onSelectEpisode: (i: number) => void;
  onClose: () => void;
  library: ReturnType<typeof useLibrary>;
  sources: SourceConfig[];
  settings: AppSettings;
}) {
  // ⑭ 关键：写入走全局单例（settings.ts 的 updateSettingsGlobal），读取走 props.settings。
  //     旧写法在这里又调了一次 useSettings()，拿到的是第 2 份互不相通的 state：
  //     写进去的那份没人读，props.settings 纹丝不动 → 片头/片尾标记后图标不变数字、跳过也不执行。
  //     现在写入会广播给所有订阅者（含把 settings 传进来的 VideoApp），props.settings 随之更新。
  const updateSettings = updateSettingsGlobal;
  const state = usePlayer();
  const { ensureResolved } = useMediaResolver(sources);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [speed, setSpeed] = useState(settings.playbackRate || 1);
  const [collapsed, setCollapsed] = useState(false);
  const [showCast, setShowCast] = useState(false);
  const [castDevice, setCastDevice] = useState<string | null>(null);
  const [localCues, setLocalCues] = useState<{ time: number; text: string }[]>([]);
  const [showSubStyle, setShowSubStyle] = useState(false); // V3.3.7 六：面板内容由「字幕样式」改为「弹幕样式」
  const [showSubtitleStyle, setShowSubtitleStyle] = useState(false); // V3.3.7 六：外挂字幕样式（入口在设置抽屉）
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
  // V3.3.5 A3：竖屏选集半屏浮层——集数多时（实测 115 集 ≈ 29 行）信息区被拉到三屏开外，
  // 竖屏改为「2 行预览 + 点开半屏浮层」，浮层内独立滚动、点遮罩/选完集关闭。
  const [epSheetOpen, setEpSheetOpen] = useState(false);
  const epSheetRef = useRef<HTMLDivElement | null>(null); // 浮层滚动容器（用于打开时定位当前集）
  // V3.3.5 A3：简介原地折叠（阅读型内容，不进浮层）
  const [introExpanded, setIntroExpanded] = useState(false);
  // V3.3.5 B4：多源封面回退——本源封面被网络阻断时，用其它启用源的同名封面顶上（仅展示层）
  // （组件 props 已有 sources=当前详情的源 id，这里取名 allSources 表示「全部已启用源列表」）
  const { sources: allSources } = useSources('video');
  // V3.3.6 八·二：当前子站（用于子站指示的 logo / 名称；无 logo 用六边形兜底）
  const curSource = allSources.find((s) => s.id === detail.sourceId);
  const curSourceName = curSource?.name ?? detail.sourceName ?? '';
  const [coverFallback, setCoverFallback] = useState<string | null>(null);
  const coverTried = useRef(''); // 已触发过跨源回退的 detail.id，防重复搜索
  useEffect(() => {
    // 换片/换源：清掉上一部的回退封面
    setCoverFallback(null);
    coverTried.current = '';
  }, [detail.id, detail.sourceId]);
  useEffect(() => {
    // 同会话内查过的片名直接命中缓存，不再跨源搜索
    if (coverFallback) return;
    const hit = cachedCrossCover(detail.title);
    if (hit) setCoverFallback(hit);
  }, [detail.id, detail.title, coverFallback]);
  const [ended, setEnded] = useState(false);    // ⑪ 单集/末集播完：重播浮层（B 方案）
  const [pipMode, setPipMode] = useState(false); // ② 进入系统画中画（隐藏控件，纯视频）

  const introDone = useRef(false);
  const pendingIntro = useRef(false); // v3.1.12：是否已发出片头 seek，等待 onSeeked/onTimeUpdate 确认到达
  const loadTimer = useRef<number | undefined>(undefined);
  const lastTouchRef = useRef(0); // ③ 触摸结束后抑制随后合成的 click，避免移动端双击被抵消
  // P1：续播四件套 —— 目标秒数 / 是否已确认到位 / 首次尝试时间戳 / 是否本组件自动 seek
  //     旧实现只有一个 appliedStartAt 布尔值，且「seek 一次就置 true」，
  //     那次 seek 一旦失败（HLS 未就绪 / duration 未就绪 / startAt 读到 0），
  //     后面所有兜底都被这个标记挡死 → 进度明明存了却从头播。
  const resumeTargetRef = useRef(0);
  const resumedRef = useRef(false);
  const resumeTryTsRef = useRef(0);
  const autoSeekingRef = useRef(false);
  // P2：最后已知播放位置。卸载时 React 已把 videoRef.current 置为 null（沙箱探针实锤：
  //     卸载 cleanup 里打印 videoRef=NULL），所以「返回时补写一次进度」从来没成功过。
  //     这里存一份不依赖 DOM 的镜像，卸载补写才真正落地。
  const lastTimeRef = useRef(0);

  const groups = (detail.raw?.lineGroups as any[] | undefined) ?? [];
  const lines = groups.length || (detail.raw?.lines as number) || 1;
  const progressKey = `${detail.sourceId}:${detail.id}`;
  // N1：续播键要带集数 —— 原 progressKey 只到「剧」这一级，同一部剧各集会互相覆盖进度。
  // 片头/片尾设置仍用 progressKey（那是按剧配置的，不该按集拆开）。
  const resumeKey = `${progressKey}:${episodeIndex}`;
  const perItem = settings.skipByItem[progressKey];
  // ⑬ 去掉全局兜底（settings.skipIntro/skipOutro），严格只认单剧标记：符合「单剧跳过、不污染其他影片」
  const introSec = perItem?.intro ?? 0;
  const outroSec = perItem?.outro ?? 0;

  // ===== N 组：续播（写入节流 + 加载恢复 + 暂停/切集/退出补写） =====
  const lastSaveRef = useRef(0);
  // 用 ref 持有实现，避免把 library / resumeKey 塞进 useCallback 依赖 ——
  // library 每次渲染都是新对象，一旦进依赖，下面的补写 effect 就会每帧重建并反复写盘，节流形同虚设。
  const saveProgressRef = useRef<(force?: boolean, key?: string) => void>(() => {});
  saveProgressRef.current = (force = false, key?: string) => {
    // P2：videoRef 在卸载阶段已被 React 清空，回落到 lastTimeRef 记录的位置。
    //     这样「返回 / 切集 / 退后台」时的最后一次补写才真的能落盘。
    const v = videoRef.current;
    const t = v && isFinite(v.currentTime) ? v.currentTime : lastTimeRef.current;
    if (!(t > 0)) return;
    const now = Date.now();
    // N4：timeupdate 约 250ms 一次，原来每秒写 4 次 localStorage；这里节流到 5 秒一次。
    // V3.3.4 #12：节流 1s → 5s（旧代码实际是 <1000，与注释不符）——配合 setProgressBoth
    // 合并写入，播放期间全量序列化写盘从每秒 2 次降到每 5 秒 1 次。
    // force=true 用于暂停 / 切集 / 退出这类"最后一次机会"的补写（N5），不受节流限制。
    if (!force && now - lastSaveRef.current < 5000) return;
    lastSaveRef.current = now;
    library.setProgressBoth(key || resumeKey, t, progressKey, episodeIndex); // 记录进度 + 看到第几集，一次写入
  };
  const saveProgress = useCallback((force = false, key?: string) => saveProgressRef.current(force, key), []);
  // N5：切集 / 切剧 / 关闭播放页时补写一次。
  // cleanup 里的 k 捕获自「上一次渲染」，所以保存的正是旧集（旧剧）的进度，不会串到新集上。
  useEffect(() => {
    const k = resumeKey;
    return () => { saveProgress(true, k); };
  }, [resumeKey, saveProgress]);
  // P4：退后台 / 切走 / 杀进程的兜底补写 —— React 的 cleanup 在 App 被系统回收时不保证执行，
  //     这两个事件是 WebView 上唯一可靠的「最后一次机会」。
  useEffect(() => {
    const flush = () => saveProgress(true);
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [saveProgress]);
  // 续播应用与防重复交由 P3 的 tryApplyResume 统一处理

  // P3：续播应用器 —— 「目标 + 校验 + 重试」，不再「seek 一次就宣布完成」。
  // 触发点覆盖 loadedmetadata / durationchange / canplay / timeupdate，
  // 只要还没真正跳到目标位置就继续重试（最长 12 秒），跳到或超窗口才收手。
  const tryApplyResume = useCallback(() => {
    const v = videoRef.current;
    const target = resumeTargetRef.current;
    if (!v || resumedRef.current || !(target > 1)) return;
    const d = v.duration;
    if (!isFinite(d) || d <= 0) return;
    if (target >= d - 3) { resumedRef.current = true; return; } // 已接近片尾 → 不跳
    if (Math.abs(v.currentTime - target) < 1.5) { resumedRef.current = true; return; } // 已到位
    const now = Date.now();
    if (resumeTryTsRef.current === 0) resumeTryTsRef.current = now;
    if (now - resumeTryTsRef.current > 12000) { resumedRef.current = true; return; } // 超时放弃，不再打扰用户
    autoSeekingRef.current = true;
    try { v.currentTime = target; } catch { /* ignore */ }
    if (Math.abs(v.currentTime - target) < 1.5) {
      resumedRef.current = true;
      setLiveCur(target);
      player.seek(target);
      toast(`上次看到 ${fmtTime(target)}，已为你续播`);
    }
    autoSeekingRef.current = false;
  }, []);

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

  // 屏幕方向：V3.3.8 Bug 1（方案 A）—— 竖屏态锁定 portrait（不再跟随重力）。
  //   竖屏态（含进入播放页）= 'portrait'：锁定竖屏，横持手机也不会自动转横；
  //     退出横屏时 effect 发 portrait，系统强制回竖，横持不赖着（解决「返回后还横着」）。
  //   点横屏按钮 = 'landscape'：SENSOR_LANDSCAPE，转横屏 + 左右横握自动切，点了必转（第 8 批硬指标）。
  //   代价：放弃「横持手机自动进横屏」，横屏必须按按钮触发（与「按钮必转」一致，更可控）。
  //   卸载（返回/关页）= 'portrait'：保证回到主页一定是竖屏。
  useEffect(() => {
    requestOrientation(landscape ? 'landscape' : 'portrait', { silent: !landscape });
    // ③ 横屏隐藏系统导航条（沉浸模式）；退回竖屏恢复
    requestImmersive(landscape);
  }, [landscape]);

  // V3.3.6 一：删除 V3.3.5 的「布局同步」自写监听——它会在旋转动画中间帧（视口尚未变横）把 landscape
  // 反向设回 false，导致手动横屏被自身监听作废。对齐 FongMi：横屏纯靠按钮触发的原生 SENSOR_LANDSCAPE，
  // 不加任何自写传感器监听。

  // V3.3.5 A3：竖屏选集浮层打开后，把面板滚动位置定位到当前集附近（115 集的剧不用手动翻）。
  // 手动算 scrollTop 而不用 scrollIntoView：后者可能把外层信息区一起带着滚。
  useEffect(() => {
    if (!epSheetOpen) return;
    requestAnimationFrame(() => {
      const c = epSheetRef.current;
      const el = c?.querySelector<HTMLElement>('.ep-cur');
      if (!c || !el) return;
      c.scrollTop = Math.max(0, el.offsetTop - c.clientHeight / 2 + el.offsetHeight / 2);
    });
  }, [epSheetOpen]);

  // Q18：组件卸载（返回/切走/关页）时强制恢复重力感应自动旋转，避免遗留横屏状态
  useEffect(() => {
    return () => {
      if (lockTimer.current) window.clearTimeout(lockTimer.current);
      if (tapTimer.current) window.clearTimeout(tapTimer.current);
      if (singleHideTimer.current) window.clearTimeout(singleHideTimer.current);
      requestOrientation('portrait');
    };
  }, []);

  // 返回手势衔接：V3.3.5 B2 改为返回栈——播放器的各浮层经 pushBackHandler 压栈，
  // 栈顶先应答（谁消费谁拦截）；全部浮层都没开时返回 false，
  // 由 VideoApp 的外层分级接手（关播放器回详情页）。__playerBack 单槽废除。
  // 依赖数组列全所有被读状态：任一浮层开合都刷新栈顶回调（旧 #10① 教训：漏依赖=闭包旧值）。
  useEffect(
    () =>
      pushBackHandler(() => {
        if (epSheetOpen) { setEpSheetOpen(false); return true; }
        if (settingsOpen) { setSettingsOpen(false); return true; }
        if (epOpen) { setEpOpen(false); return true; }
        if (showCast) { setShowCast(false); return true; }
        if (showSubStyle) { setShowSubStyle(false); return true; }
        if (showSubtitleStyle) { setShowSubtitleStyle(false); return true; }
        return false;
      }),
    [settingsOpen, epOpen, showCast, showSubStyle, showSubtitleStyle, epSheetOpen]
  );

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
  // V3.3.4 #2：Android 在 Activity 配置变化（系统栏显隐、方向切换等）时也会触发
  // onPictureInPictureModeChanged(false)——哪怕根本没进过画中画（manifest 强制开了
  // supportsPictureInPicture）。旧版把每次 false 都当"退出小窗"处理 → 自动转横屏 →
  // 竖屏信息区（封面/线路/选集/介绍）整块消失 = 用户反馈的"点进去闪一下变空白"。
  // 现在用 ref 记录真实 PiP 状态：只有真的从画中画回来才转横屏，误报一律忽略。
  const pipModeRef = useRef(false);
  useEffect(() => {
    (window as any).__onPipChanged = (entered: boolean) => {
      const wasPip = pipModeRef.current;
      pipModeRef.current = !!entered;
      setPipMode(!!entered);
      if (entered) { setControlsVisible(false); setLocked(false); }
      else if (wasPip && !landscape) toggleLandscape();
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
    let alive = true;
    // V3.3.0 #5：无播放地址（点击搜索结果立即进页、详情后台补齐中）→ 保持「解析中」转圈。
    // V3.3.1 Q3：死锁修复——旧代码在这里「转圈 → 直接 return」，而负责把地址解析出来的
    //   ensureResolved 就写在这个 return 之后，地址为空时永远执行不到：地址恒空 → 圈恒转
    //   → 连报错都不给。任何源只要剧集列表没取到（请求慢或失败）都会中招，表现为一点播放
    //   就无限转「正在解析播放地址…」。改为在本分支内主动发起解析：拿到地址写回 store，
    //   playUrl 变化触发本 effect 重跑，自然接上下面正常的加载流程；解析不出则明确报错。
    if (!state.current.playUrl) {
      setResolving(true);
      setErr(null);
      ensureResolved(state.current)
        .then((it) => {
          if (!alive) return;
          if (it.playUrl) {
            player.updateCurrent(it); // playUrl 变化 → 本 effect 重跑 → 走正常加载
          } else {
            setResolving(false);
            setErr('未取到可播放地址，换个线路或换个源试试。');
          }
        })
        .catch(() => {
          if (!alive) return;
          setResolving(false);
          setErr('解析播放地址失败，请换个源试试。');
        });
      return () => { alive = false; };
    }
    const v = videoRef.current;
    if (!v) return;
    // P3：每次（重新）加载都重设续播目标与状态，换集 / 换线路 / 重试都走这里。
    //     startAt 由上层按「列表项 id + 集数」读出，为 0 时再用本组件自己的 resumeKey 兜一次，
    //     这样即便上层读键与写入键不一致（id 漂移），本地仍能救回续播。
    const wantResume = startAt > 0 ? startAt : (library.lib.watchProgress[resumeKey] ?? 0);
    resumeTargetRef.current = wantResume;
    resumedRef.current = false;
    resumeTryTsRef.current = 0;
    introDone.current = false;
    setResolving(true);
    setErr(null);
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
        tryApplyResume();
        if (alive) setResolving(false);
      };
      v.addEventListener('loadedmetadata', onMeta);
      // A：若 loadedmetadata 在监听器挂载前就已触发（HLS 起播时序），上面的监听会漏掉，
      //    这里在 readyState>=1 时立即补一次 seek，保证续播一定生效。
      if (v.readyState >= 1) onMeta();
      // P5：旧实现 8 秒一到就 detachHls 判死 —— 弱网 / 冷启动 / 防盗链重握手稍慢，
      //     视频就被永久断开，表现为「重新点进去一直转圈然后报超时」。
      //     改成 8 秒只提示、20 秒才真正放弃，且期间不再打断 hls 加载。
      loadTimer.current = window.setTimeout(() => {
        if (alive && v.readyState < 1) {
          loadTimer.current = window.setTimeout(() => {
            if (alive && v.readyState < 1) {
              detachHls(v);
              setResolving(false);
              setErr('视频加载超时，请检查网络或换源。');
            }
          }, 12000);
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
  }, [state.current?.id, state.current?.playUrl, episodeIndex, retryNonce, startAt, detail.id, detail.sourceId]);

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

  // ⑭ 换集/换剧时重置片头/片尾「一次性」标记。
  //    introDone / outroDone 都是 useRef，挂载后不会自动清零 → 第 1 集跳过后切第 2 集时仍为 true，
  //    于是第 2 集不跳。这里必须重置。
  //    同时处理「多集共用一个 playUrl」的边界：切集时若 URL 没变，加载 effect 不会重跑，
  //    视频不会自动回到新集起点。我们在本 effect 里手动 seek 到 startAt（或 0），保证片头/续播逻辑对齐。
  useEffect(() => {
    introDone.current = false;
    pendingIntro.current = false;
    outroDone.current = false;
    outroJustSet.current = false; // ① 切集清空「片尾首次设定」标记
    clearOutroTimer();
    const v = videoRef.current;
    // v3.2.1 ⑥：换集时新视频元数据尚未就绪（duration 为 0/NaN），此时直接贴 currentTime 会被后续 load 覆盖，
    //   导致第二集从头播放。改法：设了片头就标记 pendingIntro，真正的 seek 交给 onLoadedMetadata 的 trySkipIntro；
    //   未设片头才走续播/从头（无片头时从头播是预期行为）。
    if (introSec > 0) {
      pendingIntro.current = true; // 设了片头即跳（总开关已移除）
      // C1：多集共用同一 playUrl 时 loadedmetadata 不会再次触发，onLoadedMetadata 里的 trySkipIntro 收不到。
      //     这里主动尝试跳片头，并用短轮询兜底直到真正跳过（元数据就绪前 duration 为 0，轮询等其就绪）。
      const trySeek = () => { const vv = videoRef.current; if (vv && vv.duration > 0) trySkipIntro(); };
      trySeek();
      let ticks = 0;
      const iv = window.setInterval(() => {
        ticks++;
        if (introDone.current || ticks > 40) { window.clearInterval(iv); return; }
        trySeek();
      }, 100);
      return () => window.clearInterval(iv); // effect 重跑/卸载时停掉轮询
    } else {
      const want = startAt > 0 ? startAt : (library.lib.watchProgress[resumeKey] ?? 0);
      if (v && v.duration > 0 && want > 0 && want < v.duration - 3) {
        v.currentTime = want;
        setLiveCur(want);
        player.seek(want);
      } else if (v) {
        v.currentTime = 0;
        setLiveCur(0);
        player.seek(0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, episodeIndex, resumeKey]);

  // 片头跳过
  const trySkipIntro = () => {
    const v = videoRef.current;
    if (!v || !introSec || introDone.current) return; // 设了片头即跳，无需总开关
    // v3.2.3③：只要还没到片头点就补发 seek（含「换集后 effect 已预置 pendingIntro、但元数据刚就绪
    //   currentTime 还是 0」的情况——旧逻辑在 pendingIntro 为真时直接 return，导致第 2 集从头播、片头不跳）。
    //   已到达片头点（seek 完成 / 本就已在片头之后）则收尾确认并置位，保证只跳一次。
    if (v.currentTime < introSec) {
      pendingIntro.current = true;
      player.seek(introSec);
      try { v.currentTime = introSec; } catch { /* ignore */ }
      if (v.currentTime >= introSec - 0.6) {
        introDone.current = true;
        pendingIntro.current = false;
        toast('已跳过片头');
      }
      return;
    }
    if (pendingIntro.current && v.currentTime >= introSec - 0.6) {
      introDone.current = true;
      pendingIntro.current = false;
      toast('已跳过片头');
    }
  };

  // 片尾提前连播（⑥：去掉 autoPlay 前置条件，设了片尾秒数且播到片尾即切下一集）
  // ⑮ 用户设计：进入片尾区后，继续播放 2 秒再切下一集；下一集播到片尾时间点也继续切。
  const outroDone = useRef(false);
  const outroJustSet = useRef(false); // ① 点片尾设定那一次才「先播 2 秒再跳」，之后每次立即跳
  const outroTimer = useRef<number | undefined>(undefined);
  const clearOutroTimer = () => { if (outroTimer.current) { window.clearTimeout(outroTimer.current); outroTimer.current = undefined; } };

  const trySkipOutro = () => {
    const v = videoRef.current;
    // C2：真实时长兜底优先用 <video> 实时时长（state.duration 偶发未就绪/滞后），再回退 liveDur / state.duration，
    //     保证跨集切换后片尾判定拿到的就是当前集的真实长度，避免「第 2 集片尾不跳」。
    const dur = (v && isFinite(v.duration) && v.duration > 0 && v.duration !== Infinity ? v.duration : 0)
      || liveDur || state.duration || 0;
    if (!v || !outroSec || !dur || outroDone.current) return; // 设了片尾即跳，无需总开关
    const remain = dur - v.currentTime;
    if (remain <= outroSec && remain > 0.5) {
      if (!outroTimer.current) {
        const firstSet = outroJustSet.current; // 仅首次设定那次等 2 秒，之后立即跳（300ms 给一帧渲染）
        outroTimer.current = window.setTimeout(() => {
          outroTimer.current = undefined;
          outroJustSet.current = false;
          outroDone.current = true;
          if (detail.episodes && episodeIndex < detail.episodes.length - 1) { onSelectEpisode(episodeIndex + 1); toast('已跳过片尾'); }
          else { setEnded(true); toast('已播至片尾'); } // 末集：走 B 方案（重播浮层）
        }, firstSet ? 2000 : 300);
      }
    } else {
      // 离开片尾区（用户手动往回拖）→ 取消延迟，避免误切
      clearOutroTimer();
    }
  };

  // ⑧ 片头/片尾「一键设定」：点一下用当前播放进度设定、再点清空；长按(500ms)打开分:秒手动输入面板
  // 一键设定：点一下用当前进度设定、再点清空（无长按面板；只绑 onClick，与「解码」按钮同款，真机可靠）
  const setSkipOneTap = (which: 'intro' | 'outro') => {
    try {
      const v = videoRef.current;
      const t = v ? Math.max(0, Math.floor(v.currentTime)) : 0;
      const cur = which === 'intro' ? introSec : outroSec;
      const next = cur > 0 ? 0 : t; // 已设 → 清空；未设 → 设为当前进度
      const base = settings.skipByItem[progressKey] ?? ({} as { intro?: number; outro?: number });
      updateSettings({
        skipByItem: {
          ...settings.skipByItem,
          [progressKey]: {
            // ⑭ 去掉 settings.skipIntro/skipOutro 全局兜底：取消片头时不再把全局片尾值写进单剧配置
            intro: which === 'intro' ? next : (base.intro ?? 0),
            outro: which === 'outro' ? next : (base.outro ?? 0),
          },
        },
      });
      if (which === 'outro' && next > 0) outroJustSet.current = true; // ① 本次设定后先播 2 秒再跳
      toast(which === 'intro' ? (next > 0 ? `已设片头：${fmtTime(next)}` : '已取消片头') : (next > 0 ? `已设片尾：${fmtTime(next)}` : '已取消片尾'));
    } catch (e: any) {
      toast('跳过设置失败：' + (e?.message || String(e)), 'err');
    }
  };

  // v3.2.2⑥：进度条拖动手势（pointer 事件，竖屏横屏通用；与现有 touch 手势不冲突——bar 是 hitControl，touch 冒泡到 stage 会被 return）
  const barDraggingRef = useRef(false);
  const seekToClientX = (clientX: number, el: HTMLElement) => {
    const v = videoRef.current; if (!v || !liveDur) return;
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const target = ratio * liveDur;
    v.currentTime = target; setLiveCur(target); player.seek(target);
  };
  const onBarPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    try { (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    barDraggingRef.current = true;
    startSeekLoading(false); // ⑨：拖动用，不隐藏控件（bar 需保持可交互）
    seekToClientX(e.clientX, e.currentTarget as HTMLDivElement);
  };
  const onBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (barDraggingRef.current) seekToClientX(e.clientX, e.currentTarget as HTMLDivElement);
  };
  const onBarPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (barDraggingRef.current) {
      barDraggingRef.current = false;
      try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      saveProgress(true);
      endSeekGesture(); // ⑨：拖动结束，等 seek 到位后收圈
      scheduleHide(); // V3.3.7 九：抬手后重新起 3 秒倒计时（拖动期间被挂起）
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
    // ⑬ 先检测原生桥；不可用则提示并退出，不再退化到 HTML5 PiP ——
    //    卓易通/鸿蒙 WebView 不支持 requestPictureInPicture，退化会直接把 DOMException 抛给用户看到。
    if (!pipBridgeReady()) { toast('当前环境不支持画中画'); return; }
    try {
      // ② 原生系统级画中画：点按钮即退出 App、桌面浮 16:9 小窗（A 方案）
      const m = (window as any).MuHaiAndroid;
      const ok = m.enterPip(); // 原生桥已改返回 Boolean（失败=false）
      if (!ok) toast('画中画不可用：请检查系统是否支持并已开启画中画权限');
    } catch (e: any) {
      toast('画中画启动失败：' + (e?.message || e || '未知'));
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

  // V3.3.7 十一：正在等待原生旋转结果（防连点重复下发指令）
  const landPendingRef = useRef(false);

  // ⑦：只翻转 state，真正的屏幕旋转统一由下方 [landscape] effect 驱动 requestOrientation，
  //    避免「toggleLandscape 内联 + effect 内」双调用竞态（部分 ROM 表现为「点横屏有时不灵」）
  // V3.3.7 十一（本轮重点）：进横屏改为「先转后切」——
  //   旧行为是先 setLandscape(true) 把 UI 铺满，再发原生指令；桥没注入时原生不响应，
  //   于是停在「画面被拉满、屏幕却还是竖着」的竖屏放大假横屏状态。
  //   现在：先请求原生旋转，确认真的横过来了（innerWidth > innerHeight）才切横屏 UI；
  //   失败则留在竖屏并提示，最坏情况只是「点了没反应」，永不出现假横屏。
  const toggleLandscape = () => {
    if (landscape) { setLandscape(false); return; } // 退出横屏无需等待，立即退回竖屏播放页
    if (landPendingRef.current) return;
    landPendingRef.current = true;
    requestOrientation('landscape', {
      onResult: (ok) => {
        landPendingRef.current = false;
        // 失败原因的 toast 由 orientation.ts 统一给出（区分「桥未就绪」与「系统未响应」），
        // 这里只负责「不切横屏 UI」，避免连弹两条提示。
        if (ok) setLandscape(true);
      },
    });
  };

  // V3.3.7 十一 · A：横屏稳定 3 秒后若系统方向掉回竖屏（用户把手机竖过来了 / 系统强制竖屏），
  // 自动退回竖屏播放页，避免停在「已铺满但屏幕是竖的」状态。
  // 延时 3 秒是为了避开系统旋转动画的中间帧（V3.3.6 一 的血泪教训：过早监听会把手动横屏自己作废）。
  useEffect(() => {
    if (!landscape) return;
    let cleanup: (() => void) | undefined;
    const t = window.setTimeout(() => {
      const onCheck = () => {
        if (window.innerWidth < window.innerHeight) setLandscape(false);
      };
      window.addEventListener('resize', onCheck);
      window.addEventListener('orientationchange', onCheck);
      cleanup = () => {
        window.removeEventListener('resize', onCheck);
        window.removeEventListener('orientationchange', onCheck);
      };
    }, 3000);
    return () => { window.clearTimeout(t); cleanup?.(); };
  }, [landscape]);

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
    // ⑨ 控件隐藏时，点「原按钮位置」只把控件唤出、不触发按钮：touch 阶段就吞掉，按钮收不到 touch/click
    if (hitControl && !controlsVisible) {
      try { e.preventDefault(); } catch { /* ignore */ }
      setControlsVisible(true);
      if (state.isPlaying) scheduleHide();
      el.__sx = null; el.__moved = true; return;
    }
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
        startSeekLoading(true); // ⑨：立即起转圈（绕过 buffering 的 300ms 延迟）
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
          if (singleHideTimer.current) { window.clearTimeout(singleHideTimer.current); singleHideTimer.current = undefined; }
          setLockHidden((v) => !v);
        } else if (epOpen) {
          setEpOpen(false); // ⑦ 横屏选集浮层：点播放窗口空白即关
        } else if (settingsOpen) {
          setSettingsOpen(false); // ⑨ 横屏设置侧栏：点空白即关
        } else if (showCast) {
          setShowCast(false);
        } else if (tapTimer.current) {
          // 第二击 = 双击：播放/暂停。
          window.clearTimeout(tapTimer.current);
          tapTimer.current = undefined;
          if (singleHideTimer.current) { window.clearTimeout(singleHideTimer.current); singleHideTimer.current = undefined; }
          const wasVisible = el.__tapVisible !== false;
          player.toggle();
          setControlsVisible(wasVisible);
          if (wasVisible && state.isPlaying) scheduleHide();
        } else {
          // 第一击：记下「双击前控件是否可见」，存到 DOM 元素上（不受后续 re-render 影响）
          const wasVisible = controlsVisible;
          el.__tapVisible = wasVisible;
          // ⑩ 双击判定窗口（280ms）与单击显隐（280ms）分离。
          //     第一击不再立即显示图标（解决「双击暂停会闪一下所有图标」）：
          //     280ms 内无第二击 = 单击 → 可见态隐藏 / 隐藏态显示；有第二击 = 双击 → 只 toggle，不改显隐。
          tapTimer.current = window.setTimeout(() => { tapTimer.current = undefined; }, 280);
          singleHideTimer.current = window.setTimeout(() => {
            singleHideTimer.current = undefined;
            if (wasVisible) {
              // ④：可见态单击 → 隐藏；顺手清掉可能残留的自动隐藏定时器，避免再次翻面
              setControlsVisible(false);
              if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = undefined; }
            } else {
              // ④：隐藏态单击 → 显示，并重新启动 3 秒自动隐藏倒计时（此前漏了 scheduleHide，控件一直亮着）
              setControlsVisible(true);
              if (state.isPlaying) scheduleHide();
            }
          }, 280);
        }
      }
      if (el.__backing) {
        if (settingsOpen) setSettingsOpen(false);
        else if (showCast) setShowCast(false);
        else if (showSubStyle) setShowSubStyle(false);
        else if (showSubtitleStyle) setShowSubtitleStyle(false);
        else if (landscape) toggleLandscape();
        else onClose();
      }
      // ⑨ 滑动手势结束：收掉「加载中」转圈。左右滑动只调了 startSeekLoading（没调 endSeekGesture），
      //    若不在这里补一刀，seekGestureActive.current 永远为 true，clearSeekLoadingOnSettled 永远清不掉圈（①）。
      //    竖滑（亮度/音量）没起过圈，endSeekGesture 是无害空操作。
      if (el.__moved) endSeekGesture();
      el.__sx = null; el.__sy = null; el.__accum = 0; el.__dir = 0; el.__backing = false; el.__half = null; el.__moved = false; el.__ts = 0;
      lastTouchRef.current = Date.now(); // ③ 抑制随后合成的 click
    }
  };
  const tapTimer = useRef<number | undefined>(undefined);   // 双击判定窗口（第一击后 280ms 内有第二击 = 双击）
  const singleHideTimer = useRef<number | undefined>(undefined); // 单击隐藏（280ms，与双击窗口分离，避免 clearTapTimer 误清导致双击失效）
  // K2：清掉可能残留的单击/双击定时器。
  // 场景 —— 先点一下空白（起了 280ms 定时器），紧接着点某个控件按钮：
  // 按钮动作执行完之后，迟到的定时器才到点，又把控件显隐翻一次，
  // 表现就是"控件自己莫名其妙藏起来 / 弹出来"。
  // 用 touchstart 捕获阶段挂在 overlay 上：既早于 touchend（不会误清本次新起的定时器），
  // 又能一次性覆盖 overlay 内的所有按钮（含横屏底部 10 个工具键）。
  const clearTapTimer = useCallback(() => {
    // 只清单击隐藏定时器；绝不碰 tapTimer（双击窗口），否则第二次轻触的 touchstart 捕获清掉第一次轻触的窗口，双击失效（⑥）
    if (singleHideTimer.current) { window.clearTimeout(singleHideTimer.current); singleHideTimer.current = undefined; }
  }, []);
  // ⑭ 控件隐藏时的点击守卫（挂在竖屏/横屏 overlay 的 onClickCapture）
  // 需求：控件自动隐藏后点屏幕，无论点的是空白还是「原本有图标的位置」，都只是把控件唤出来，
  //       绝不执行那个按钮的动作（例如横屏下点在「设置」原位置 → 只显控件，不弹设置抽屉）。
  // CSS 侧已有 .overlay.hide * { pointer-events: none !important }，但卓易通/鸿蒙 WebView 对
  // pointer-events 的实现不彻底，某些按钮仍能收到 click。这里在捕获阶段再兜一道：
  // stopPropagation 会拦住后续冒泡，按钮自己的 onClick 就不会执行了。
  // 锁定态不拦截 —— 锁定态下小锁是唯一可点元素，交给 onStageTouchEnd 的 locked 分支处理。
  const guardTapWhenHidden = (e: React.MouseEvent) => {
    if (locked) return;
    if (controlsVisible) return;
    e.stopPropagation();
    e.preventDefault();
    setControlsVisible(true);
    if (state.isPlaying) scheduleHide();
  };
  // 单击切换控件显隐；播放态 3s 后自动隐藏；锁屏强制常显（竖屏/横屏通用）
  const scheduleHide = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    // B9：去掉 locked —— 锁定态也要启动 3 秒定时器，让小锁自动隐藏（此前小锁永远亮着）
    if (!state.isPlaying) return;
    // V3.3.7 九：拖动进度条期间挂起自动隐藏。
    // 症状：按住进度条微调超过 3 秒，整层控制图标（连进度条自己）凭空消失。
    if (barDraggingRef.current) return;
    hideTimer.current = window.setTimeout(() => {
      // 定时器到点时若手指还按在进度条上，同样不放行（避免边界情况下刚拖到 3 秒就被藏掉）
      if (barDraggingRef.current) return;
      setControlsVisible(false);
    }, 3000);
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

  // V3.3.7：长按手势（只给「横屏弹幕按钮」用）——按住 480ms 唤出弹幕样式浮窗，
  // 触发后抑制紧随其后的 click，避免「开面板的同时又把弹幕关了」。
  // 竖屏按用户明确要求不接长按（竖屏单击=开关弹幕，样式入口在播放器设置抽屉里）。
  const longPressTimer = useRef<number | undefined>(undefined);
  const longPressFired = useRef(false);
  const dmStart = useRef<{ x: number; y: number } | null>(null);
  const dmPressStart = () => {
    longPressFired.current = false;
    dmStart.current = null;
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      setShowSubStyle(true);
      try { (navigator as any).vibrate?.(15); } catch { /* ignore */ }
    }, 480);
  };
  // V3.3.8 Bug 2：长按加 12px 移动阈值——手指轻微抖动（<12px）忽略、不清定时器；
  //   只有真正滑走（>12px）才取消长按。修复「长按不出弹幕面板」（touchmove 抖动误杀 480ms 定时器）。
  const dmPressMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    if (!dmStart.current) { dmStart.current = { x: t.clientX, y: t.clientY }; return; }
    const dx = Math.abs(t.clientX - dmStart.current.x);
    const dy = Math.abs(t.clientY - dmStart.current.y);
    if (dx > 12 || dy > 12) dmPressEnd();
  };
  const dmPressEnd = () => {
    if (longPressTimer.current) { window.clearTimeout(longPressTimer.current); longPressTimer.current = undefined; }
  };
  const dmClick = () => {
    if (longPressFired.current) { longPressFired.current = false; return; } // 长按已处理，忽略这次 click
    toggleDanmaku();
  };

  const toggleDanmaku = () => {
    const next = !danmaku;
    setDanmaku(next);
    updateSettings({ enableDanmaku: next });
  };

  const ss = settings.subtitleStyle;
  // V3.3.7 六：弹幕样式（作用到 .dm，与外挂字幕的 ss 分开）
  const ds = settings.danmakuStyle;
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
    objectFit: (settings.videoScale ? (settings.videoScale === 'cover' ? 'cover' : settings.videoScale === 'stretch' ? 'fill' : 'contain') : (SCALE_FIT[scaleMode] ?? 'contain')) as React.CSSProperties['objectFit'],
    objectPosition: 'center', // P5-2：「原始」不放大时居中
    filter: brightness < 1 ? `brightness(${brightness})` : undefined,
  };
  // 需要锁容器比例的两档；其余档保持容器原样（竖屏 16:9 / 横屏全屏）
  const lockRatio = SCALE_RATIO[scaleMode] || '';
  // V3.3.6 八·二：genre 标签整行删除，改由子站指示 [图标]│[子站名] 代替
  const vr = detail.raw as any;
  const filmYear = vr?.vod_year || vr?.year;
  const director = vr?.vod_director || vr?.director;
  const actor = vr?.vod_actor || vr?.actor;
  // V3.3.5 A3：直接显示源返回的 remarks 原文——旧版只认「完结/连载」两个字，
  // 而 LZ 实测追更剧的 remarks 是「更新至第157集」这类格式，永远匹配不上 → 用户从未见过集数标签。
  // 现改为原文显示（「更新至第157集」/「已完结」），只过滤 HD 这类无集数信息的占位值。
  const rawRemarks = String(vr?.vod_remarks || '').trim();
  const statusTag = rawRemarks && !/^(hd|hd高清|高清|tc|ts)$/i.test(rawRemarks) ? rawRemarks : '';
  // V3.3.6 八·二：genre/4K/杜比 标签整行删除（由子站指示取代）；statusTag 改放「选集」标题右侧

  // V3.3.6 二：集数去汉字、去前导 0、从 1 开始——「第01集」→「1」、「第108集」→「108」；
  // 非数字特殊名（如「预告片」「会员专属」）保留原样；无名字时回退为序号。
  const cleanEp = (name?: string, idx?: number): string => {
    if (name) {
      const m = name.replace(/^第/, '').replace(/集$/, '').match(/\d+/);
      if (m) return String(parseInt(m[0], 10));
    }
    return idx != null ? String(idx + 1) : '';
  };
  const epName = cleanEp(detail.episodes?.[episodeIndex]?.name, episodeIndex);

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
  // ⑨：用户主动快进/拖动时的加载转圈（独立于 overlay，控件隐藏也显示；控件显示时滑动则隐藏其余控件）
  const [seekLoading, setSeekLoading] = useState(false);
  const [seekHideControls, setSeekHideControls] = useState(false);
  const seekLoadingTimer = useRef<number | undefined>(undefined);
  const seekGestureActive = useRef(false);
  const startSeekLoading = useCallback((hideControls: boolean) => {
    if (seekLoadingTimer.current) window.clearTimeout(seekLoadingTimer.current);
    seekLoadingTimer.current = undefined;
    seekGestureActive.current = true;
    setSeekHideControls(hideControls);
    setSeekLoading(true);
  }, []);
  const endSeekGesture = useCallback(() => {
    seekGestureActive.current = false;
    if (seekLoadingTimer.current) window.clearTimeout(seekLoadingTimer.current);
    // 抬手后等 seek 真正到位（onSeeked）再清；兜底 350ms
    seekLoadingTimer.current = window.setTimeout(() => { setSeekLoading(false); setSeekHideControls(false); }, 350);
  }, []);
  const clearSeekLoadingOnSettled = useCallback(() => {
    if (!seekGestureActive.current) {
      if (seekLoadingTimer.current) window.clearTimeout(seekLoadingTimer.current);
      setSeekLoading(false);
      setSeekHideControls(false);
    }
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
            // P3：用户自己拖进度条 / 手势快进时，放弃自动续播，不与用户抢位置
            onSeeking={() => { if (!autoSeekingRef.current) resumedRef.current = true; markBuffering(); }}
            onPlaying={() => { clearBuffering(); clearSeekLoadingOnSettled(); }}
            onCanPlay={() => { clearBuffering(); tryApplyResume(); }}
            onSeeked={() => { saveProgress(true); clearBuffering(); tryApplyResume(); trySkipIntro(); clearSeekLoadingOnSettled(); }}
            onTimeUpdate={(e) => {
              const v = e.target as HTMLVideoElement;
              setLiveCur(v.currentTime);
              setLiveDur(v.duration || 0);
              lastTimeRef.current = v.currentTime; // P2：卸载补写的镜像
              player.setProgress(v.currentTime);
              // T4：已缓冲进度 = buffered 末尾 / 总时长（reused 现有 250ms 周期，不必另开定时器）
              try {
                if (v.buffered.length && v.duration > 0) {
                  const end = v.buffered.end(v.buffered.length - 1);
                  setBufPct(Math.min(100, (end / v.duration) * 100));
                }
              } catch { /* ignore */ }
              saveProgress(); // N4：内部 5 秒节流
              tryApplyResume(); // P3：只要还没真正跳到目标位置就继续重试
              trySkipIntro();
              trySkipOutro();
            }}
            onLoadedMetadata={(e) => {
              const v = e.target as HTMLVideoElement;
              setLiveDur(v.duration || 0);
              player.setDuration(v.duration);
              if (v.videoWidth && v.videoHeight) setResText(`${v.videoWidth}x${v.videoHeight}`);
              tryApplyResume(); trySkipIntro(); // P3 + v3.2.1⑥：元数据就绪即尝试跳片头（解决第二集从头播）
            }}
            onDurationChange={(e) => {
              const v = e.target as HTMLVideoElement;
              setLiveDur(v.duration || 0);
              tryApplyResume(); // P3：HLS 的 duration 常常晚于 loadedmetadata 才好，这里再补一次
            }}
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

          {!state.current?.playUrl && !err && (
            <div className="vp-resolving">
              <div className="spin" />
              <span>正在解析播放地址…</span>
            </div>
          )}
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
            <Danmaku active={state.isPlaying} seed={detail.id + episodeIndex} items={detail.danmaku} style={settings.danmakuStyle} />
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

          {/* ⑨⑩ 快进气泡：目标时间 / 总时长（深色圆角药丸，顶部居中，差异化样式） */}
          {seekBubble && (
            <div className="seek-bubble">
              <span>{fmtTime(seekBubble.target)}</span>
              <span className="sep">/</span>
              <span>{fmtTime(liveDur || state.duration || 0)}</span>
            </div>
          )}

          {/* ⑨ 滑动/拖动快进：独立加载中圆圈（居中，不受控件显隐影响） */}
          {seekLoading && (
            <div className="vp-seek-loader">
              <div className="vp-seek-loader-circle"><span className="vp-spinner" /></div>
              <span className="vp-seek-loader-text">加载中</span>
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
            <div className={'overlay' + (controlsVisible && !seekHideControls ? '' : ' hide') + (locked ? ' locked' : '') + (resolving && !err ? ' loading' : '')} onTouchStartCapture={clearTapTimer} onClickCapture={guardTapWhenHidden}>
              <div className="top">
                <button className="back" onClick={onClose} title="返回"><Icon name="arrow-left" size={18} /></button>
                <div className="ttl">
                  <span className="name">{detail.title} · {epName}</span>
                  <span className="res">[{qualityLabel || resText || '1920x804'}]</span>
                </div>
                <div className="acts">
                  <button className={'icon lock-btn' + (locked ? ' on' : '') + (lockHidden ? ' lock-hidden' : '')} onClick={() => toggleLock()} title={locked ? '已锁定' : '锁定屏幕'}><Icon name={locked ? 'lock' : 'lock-open'} size={16} /></button>
                </div>
              </div>
              <div className="center">
                <button className="big-btn" onClick={() => player.toggle()} title={state.isPlaying ? '暂停' : '播放'}>
                  {/* T3：缓冲转圈与播放键原地合体 —— 同一圆圈同一位置，只换里面内容 */}
                  {buffering ? <span className="vp-spinner" /> : <Icon name={state.isPlaying ? 'pause' : 'play'} size={30} />}
                </button>
              </div>
              <div className="bottom">
                <div className="bottom-row">
                  {/* V3.3.6 十二：删竖屏底栏左侧播放/暂停钮——播放/暂停改点中间大按钮或轻触画面 */}
                  <span className="t cur">{fmtTime(liveCur)}</span>
                  <div className="bar" onClick={(e) => {
                    const v = videoRef.current; if (!v || !liveDur) return;
                    const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                    v.currentTime = ratio * liveDur; setLiveCur(v.currentTime); player.seek(v.currentTime);
                  }} onPointerDown={onBarPointerDown} onPointerMove={onBarPointerMove} onPointerUp={onBarPointerUp}>
                    {/* T4：已缓冲进度（浅色），复用 onTimeUpdate 兜底刷新，层级介于轨道与已播放之间 */}
                    <div className="buffered" style={{ width: `${bufPct}%` }} />
                    <div className="fill" style={{ width: `${liveDur ? (liveCur / liveDur) * 100 : 0}%` }} />
                    {/* V3.3.7 十：播放位置圆点，left 随进度百分比 */}
                    <div className="knob" style={{ left: `${liveDur ? (liveCur / liveDur) * 100 : 0}%` }} />
                  </div>
                  <span className="t dur">{fmtTime(liveDur)}</span>
                  <button className="land" onClick={toggleLandscape} title="横屏"><Icon name="rotate" size={18} /></button>
                </div>
              </div>
              {/* 竖屏左中：弹幕（从右上移到左中） */}
              <div className="vp-side vp-side-left">
                <button className={'side-btn' + (danmaku ? ' on' : '')} onClick={toggleDanmaku} disabled={!detail.danmaku || detail.danmaku.length === 0} title={danmaku ? '弹幕开' : '弹幕关'}><Icon name="message" size={16} /></button>
              </div>
              {/* 竖屏右中：画中画（绑原生桥 enterPip） */}
              <div className="vp-side vp-side-right">
                <button className="side-btn" onClick={(e) => { e.stopPropagation(); onPip(); }} title="画中画" disabled={!settings.pipEnabled}><Icon name="pip" size={16} /></button>
              </div>
            </div>
          )}

          {/* ============ 横屏：水平布局（对齐视频播放器UI.html：顶栏 + 左右边栏 + 中央水平播放控制 + 底部进度条 + 底部横排工具） ============ */}
          {landscape && (
            <div className={'overlay land-h' + (controlsVisible && !seekHideControls ? '' : ' hide') + (locked ? ' locked' : '') + (resolving && !err ? ' loading' : '')} onTouchStartCapture={clearTapTimer} onClickCapture={guardTapWhenHidden}>
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
                {/* V3.3.7：横屏弹幕按钮 —— 单击开关弹幕，长按唤出弹幕样式浮窗 */}
                <button
                  className={'icon' + (danmaku ? ' on' : '')}
                  onTouchStart={dmPressStart} onTouchEnd={dmPressEnd} onTouchCancel={dmPressEnd} onTouchMove={dmPressMove}
                  onMouseDown={dmPressStart} onMouseUp={dmPressEnd} onMouseLeave={dmPressEnd}
                  onClick={dmClick}
                  disabled={!detail.danmaku || detail.danmaku.length === 0}
                  title={danmaku ? '弹幕开（长按改样式）' : '弹幕关（长按改样式）'}
                ><Icon name="message" size={20} /></button>
              </div>

              {/* 右侧边栏：投屏 / 画中画 */}
              <div className="side right">
                <button className="icon" onClick={(e) => { e.stopPropagation(); setShowCast(true); }} title="投屏"><Icon name="tv" size={20} /></button>
                <button className="icon" onClick={(e) => { e.stopPropagation(); onPip(); }} title="画中画" disabled={!settings.pipEnabled}><Icon name="pip" size={20} /></button>
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
                  }} onPointerDown={onBarPointerDown} onPointerMove={onBarPointerMove} onPointerUp={onBarPointerUp}>
                    <div className="buffered" style={{ width: `${bufPct}%` }} />
                  <div className="fill" style={{ width: `${liveDur ? (liveCur / liveDur) * 100 : 0}%` }} />
                  {/* V3.3.7 十：横屏进度条同样加播放位置圆点 */}
                  <div className="knob" style={{ left: `${liveDur ? (liveCur / liveDur) * 100 : 0}%` }} />
                  </div>
                  <span className="t">{fmtTime(liveDur)}</span>
                  <button className="land" onClick={toggleLandscape} title="退出横屏"><Icon name="rotate" size={18} /></button>
                </div>
                <div className="tools">
                  <button className={'tool' + (DECODE_CYCLE.indexOf(decodeMode as any) >= 0 ? ' on' : '')} onClick={toggleDecode}><Icon name="sliders" size={15} /><span>解码</span></button>
                  <button className="tool" onClick={retry}><Icon name="refresh" size={15} /><span>刷新</span></button>
                  <button className="tool" onClick={() => { const v = videoRef.current; if (v) { v.currentTime = 0; v.play().catch(() => {}); } }}><Icon name="replay" size={15} /><span>重播</span></button>
                  {/* V3.3.7 六：「字幕」→「弹幕」，且与弹幕开关状态联动（此前点了是打开外挂字幕面板，名不副实） */}
                  <button className={'tool' + (danmaku ? ' on' : '')} onClick={() => toggleDanmaku()} disabled={!detail.danmaku || detail.danmaku.length === 0}><Icon name="message" size={15} /><span>弹幕</span></button>
                  <button className={'tool' + (introSec ? ' on' : '')} onClick={() => setSkipOneTap('intro')}>{introSec > 0 ? <span className="skip-num">{fmtTime(introSec)}</span> : <Icon name="skip-back" size={15} />}<span>片头</span></button>
                  <button className={'tool' + (outroSec ? ' on' : '')} onClick={() => setSkipOneTap('outro')}>{outroSec > 0 ? <span className="skip-num">{fmtTime(outroSec)}</span> : <Icon name="skip-forward" size={15} />}<span>片尾</span></button>
                  <button className={'tool' + (audioMode !== '关闭' ? ' on' : '')} onClick={cycleAudio}><Icon name="volume" size={15} /><span>音效</span></button>
                  {/* S2：单码率片源（levels.length === 1）置灰并显示「单档」，让用户知道不是按钮坏了 */}
                  <button className="tool" onClick={cycleQuality} disabled={levels.length === 1}
                    title={levels.length === 1 ? '当前片源只有一档' : '选择清晰度'}>
                    <Icon name="sparkles" size={15} /><span>{levels.length === 1 ? '单档' : (qualityLabel || '画质')}</span>
                  </button>
                  {/* ⑬ 选集改为右侧浮层（同「设置」抽屉），不再用页面内 scrollToEpisodes（会被整屏 .player-card.land 盖住） */}
                  <button className="tool" onClick={() => setEpOpen(true)}><Icon name="list" size={15} /><span>选集</span></button>
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
                {/* V3.3.5 B4：本源封面两级加载都失败（onFinalFail）时，跨源找同名封面顶上；
                    key=src 保证切换回退 URL 时 ProxiedImg 重建内部加载状态 */}
                {detail.cover ? (
                  <ProxiedImg
                    key={coverFallback || detail.cover}
                    src={coverFallback || detail.cover}
                    alt=""
                    fallbackText={detail.title}
                    onFinalFail={() => {
                      tryCoverFallback({
                        key: detail.id,
                        title: detail.title,
                        allSources,
                        onResolved: (u) => setCoverFallback(u),
                      });
                    }}
                  />
                ) : <span style={{ color: '#fff', fontSize: 26 }}>{initial(detail.title)}</span>}
            </div>
            <div className="info-body">
              <div className="info-title">{detail.title}</div>
              <div className="info-score">{(detail.raw as any)?.rating || '8.4'}<span className="stars">★★★★<span className="empty">★</span></span></div>
              {/* V3.3.7 四：一行连排 + 2 行截断 → 改回竖排，每行一条、单行省略（对齐设计稿） */}
              <div className="info-meta">
                {filmYear && <div className="row"><span className="label">年份</span>{filmYear}</div>}
                {(vr as any)?.vod_area && <div className="row"><span className="label">地区</span>{(vr as any).vod_area}</div>}
                {director && <div className="row"><span className="label">导演</span>{director}</div>}
                {actor && <div className="row"><span className="label">主演</span>{actor}</div>}
              </div>
              <button className={'fav-btn' + (faved ? ' on' : '')} onClick={() => { library.toggleFavorite(detail); setFaved(library.isFavorite(detail)); }}>
                {faved ? '已收藏' : '加入收藏'}
              </button>
            </div>
          </div>

          {/* V3.3.6 八·二：子站指示 [logo/六边形] │ [子站名] */}
          <div className="src-chip">
            {curSource?.logo ? (
              <img className="src-logo" src={curSource.logo} alt="" />
            ) : (
              <span className="src-hex" style={{ background: subsiteColor(curSourceName) }}>
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3.5 L19 7.8 L19 16.2 L12 20.5 L5 16.2 L5 7.8 Z" fill="none" stroke="#fff" strokeWidth="2" /></svg>
              </span>
            )}
            <span className="sep" />
            <span className="src-name">{curSourceName}</span>
          </div>

          {/* 4 操作按钮（缓存/解码/投屏/设置）— 占位展示，待用户确认哪些要接 */}
          <div className="actions">
            {/* V3.3.4 #14：缓存改用解析后的播放对象（state.current 带 playUrl）——旧版传原始列表项
                detail，realDownload 拿不到地址直接抛"该源不支持直接下载"，缓存对常规流程必然失败 */}
            <button onClick={() => downloadStore.start(state.current?.playUrl ? state.current : detail)} title="缓存"><span className="circle"><Icon name="download" size={24} /></span>缓存</button>
            <button className={DECODE_CYCLE.indexOf(decodeMode as any) >= 0 ? 'on' : ''} onClick={toggleDecode} title="解码/音效"><span className="circle"><Icon name="sliders" size={24} /></span>系统</button>
            <button onClick={() => setShowCast(true)} title="投屏"><span className="circle"><Icon name="tv" size={24} /></span>投屏</button>
            <button onClick={() => setSettingsOpen(true)} title="播放器设置"><span className="circle"><Icon name="settings" size={24} /></span>设置</button>
          </div>

          {lines > 0 && (
            <div className="section">
              <div className="sec-head"><span className="sec-title">线路</span><span className="sec-more" onClick={() => {}}>自动选速 &gt;</span></div>
              {/* V3.3.5 A3：优先显示源返回的真实线路名（normal.ts toLineGroups 解析 vod_play_from，
                  如 LZ 的 liangzi / lzm3u8），没有才回退到编号 */}
              <div className="line-row">
                {Array.from({ length: lines }).map((_, i) => (
                  <button key={i} className={i === line ? 'active' : ''} onClick={() => onLineChange(i)}>{((detail.raw as any)?.lineNames as string[] | undefined)?.[i] || LINE_NAMES[i] || `线路${i + 1}`}</button>
                ))}
              </div>
            </div>
          )}

          {/* V3.3.3：选集区块始终显示——有集数渲染网格，无集数显示「暂无选集」占位，不再整块消失
              V3.3.5 A3：竖屏改为「2 行预览（8 个，窗口跟随当前集）+ 全部 N 集 › 半屏浮层」——
              115 集的剧不再把信息区拉成 29 行（≈1580px）。横屏仍走 epOpen 抽屉不变。 */}
          <div className="section">
            <div className="sec-head">
              <div className="sec-left">
                <span className="sec-title">选集</span>
                {statusTag && <span className="ep-update">{statusTag}</span>}
              </div>
              {detail.episodes && detail.episodes.length > 0 && (
                <span className="sec-actions">
                  {detail.episodes.length > 1 && <span className="sec-more" onClick={() => setAsc((v) => !v)}>{asc ? '正序 ▾' : '倒序 ▴'}</span>}
                  <span className="sec-more ep-all" onClick={() => setEpSheetOpen(true)}>全部 {detail.episodes.length} 集 ›</span>
                </span>
              )}
            </div>
            {detail.episodes && detail.episodes.length > 0 ? (
              <div className="ep-grid">
                {(() => {
                  const list = detail.episodes!;
                  // 预览窗口：以当前集为中心取 8 个（2 行 × 4 列）——追剧时打开直接看到当前集附近
                  const PREVIEW = 10; // V3.3.6 三：5 列 × 2 行 = 10 格
                  const win =
                    list.length <= PREVIEW
                      ? list.map((_, i) => i)
                      : Array.from({ length: PREVIEW }, (_, k) => Math.max(0, Math.min(list.length - PREVIEW, episodeIndex - 4)) + k);
                  const order = asc ? win : win.slice().reverse();
                  return order.map((i) => {
                    const ep = list[i];
                    const cur = i === episodeIndex;
                    return (
                      <button key={i} className={(cur ? 'active ep-cur' : '') + (ep.locked ? ' locked' : '')} onClick={() => onSelectEpisode(i)}>
                        {ep.locked ? '锁' : cleanEp(ep.name, i)}
                        {cur && <span className="ep-dot" />}
                      </button>
                    );
                  });
                })()}
              </div>
            ) : (
              <p className="detail-note">该源未提供选集列表，可尝试切换线路或换其它源。</p>
            )}
          </div>

          {(() => {
            const raw = detail.raw as any;
            // V3.3.3：优先读 detail.desc（toDetail 已统一字段映射），再从 raw 兜底，确保简介能显示
            const intro = detail.desc || raw?.vod_content || raw?.vod_blurb || raw?.vod_remarks || raw?.vod_des || raw?.desc;
            // 详情解析中 → 介绍位置显示骨架；确认无介绍 → 「暂无介绍」占位
            return (
              <>
                {detailLoading && (
                  <div className="intro">
                    <div className="sec-head"><span className="sec-title">介绍</span></div>
                    <div className="skel-block"><div className="skel-line w60" /><div className="skel-line" /><div className="skel-line w40" /></div>
                  </div>
                )}
                {!detailLoading && (
                  <div className="intro">
                    <div className="sec-head"><span className="sec-title">介绍</span></div>
                    {/* V3.3.5 A3：简介原地折叠——默认 3 行，点「展开 ▾」就地长开全文、变「收起 ▴」。
                        阅读型内容不适合塞进浮层（那是选集这类操作型内容用的），故原地展开。 */}
                    {intro ? (
                      <>
                        {director && <p className="intro-extra"><span className="label">导演</span> {director}</p>}
                        {actor && <p className="intro-extra"><span className="label">主演</span> {actor}</p>}
                        <p className={introExpanded ? '' : 'intro-clamp'}>{String(intro)}</p>
                        {String(intro).length > 60 && (
                          <button className="intro-toggle" onClick={() => setIntroExpanded((v) => !v)}>
                            {introExpanded ? '收起 ▴' : '展开 ▾'}
                          </button>
                        )}
                      </>
                    ) : <p className="intro-empty">暂无介绍</p>}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* S2 · 清晰度档位选择：多码率 m3u8 才出现，选中即刻生效 */}
      {levelOpen && (
        <div className="vp-drawer-mask" onClick={() => setLevelOpen(false)}>
          <div className="vp-sub-drawer" onClick={(e) => e.stopPropagation()}>
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
        </div>
      )}

      {/* V3.3.7 六：原「字幕样式」面板改「弹幕样式」——此前它控制的是外挂字幕（.vp-subtitle，
          仅在片源自带 SRT/VTT 且弹幕关闭时才显示），而用户日常看到的是弹幕，
          于是反馈「这个不是字幕样式，是弹幕样式」。现在字号/颜色/描边/速度/区域/透明度全部落到 .dm。
          关闭按钮已删除（点遮罩关闭），外挂字幕入口并入播放器设置抽屉。 */}
      {showSubStyle && (
        <div className="vp-drawer-mask" onClick={() => setShowSubStyle(false)}>
          <div className="vp-sub-drawer" onClick={(e) => e.stopPropagation()}>
          <div className="vp-panel-head">弹幕样式</div>
          <div className="vp-panel-row">
            <span>开启弹幕</span>
            <button className={'mini' + (danmaku ? ' active' : '')} onClick={() => toggleDanmaku()}>{danmaku ? '开' : '关'}</button>
          </div>
          <label>字号 <b>{ds.size}px</b>
            <input type="range" min={12} max={40} step={1} value={ds.size} onChange={(e) => updateSettings({ danmakuStyle: { ...ds, size: Number(e.target.value) } })} />
          </label>
          <label>颜色 <input type="color" value={ds.color} onChange={(e) => updateSettings({ danmakuStyle: { ...ds, color: e.target.value } })} /></label>
          <label>透明度 <b>{ds.opacity}%</b>
            <input type="range" min={20} max={100} step={5} value={ds.opacity} onChange={(e) => updateSettings({ danmakuStyle: { ...ds, opacity: Number(e.target.value) } })} />
          </label>
          <label>速度 <b>{(ds.speed / 100).toFixed(1)}x</b>
            <input type="range" min={50} max={200} step={10} value={ds.speed} onChange={(e) => updateSettings({ danmakuStyle: { ...ds, speed: Number(e.target.value) } })} />
          </label>
          <label>显示区域 <b>{ds.area}%</b>
            <input type="range" min={20} max={100} step={10} value={ds.area} onChange={(e) => updateSettings({ danmakuStyle: { ...ds, area: Number(e.target.value) } })} />
          </label>
          <div className="vp-panel-row">
            <label className="row"><input type="checkbox" checked={ds.outline} onChange={(e) => updateSettings({ danmakuStyle: { ...ds, outline: e.target.checked } })} /> 描边</label>
          </div>
          </div>
        </div>
      )}

      {/* V3.3.7 六：外挂字幕样式保留（仅片源自带 SRT/VTT 时才有内容），入口从工具栏挪进设置抽屉 */}
      {showSubtitleStyle && (
        <div className="vp-drawer-mask" onClick={() => setShowSubtitleStyle(false)}>
          <div className="vp-sub-drawer" onClick={(e) => e.stopPropagation()}>
          <div className="vp-panel-head">外挂字幕样式</div>
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
        </div>
      )}

      {/* 跳过片头片尾：播放页内一键设定，无独立输入面板 */}

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

            {/* V3.3.7 六：弹幕样式 / 外挂字幕样式入口（工具栏不再占「字幕」按钮位） */}
            <div className="dg"><div className="dg-label">字幕与弹幕</div><div className="dg-row">
              <button onClick={() => { setSettingsOpen(false); setShowSubStyle(true); }}>弹幕样式</button>
              <button onClick={() => { setSettingsOpen(false); setShowSubtitleStyle(true); }}>外挂字幕</button>
            </div></div>

            {!landscape && (
            <div className="dg"><div className="dg-label">快捷操作</div><div className="dg-quick">
              <button className={introSec ? 'on' : ''} onClick={() => setSkipOneTap('intro')}>{introSec > 0 ? <span className="skip-num">{fmtTime(introSec)}</span> : <Icon name="fast-forward" size={22} style={{ transform: 'scaleX(-1)' }} />}<span>片头</span></button>
              <button className={outroSec ? 'on' : ''} onClick={() => setSkipOneTap('outro')}>{outroSec > 0 ? <span className="skip-num">{fmtTime(outroSec)}</span> : <Icon name="fast-forward" size={22} />}<span>片尾</span></button>
              <button className={autoPlay ? 'on' : ''} onClick={() => { setAutoPlay((v) => { localStorage.setItem('rf_autoplay', v ? '0' : '1'); return !v; }); }}><Icon name="repeat" size={22} /><span>连播</span></button>
              <button onClick={retry}><Icon name="refresh" size={22} /><span>刷新</span></button>
            </div></div>
            )}
          </div>
        </div>
      )}

      {/* V3.3.5 A3：竖屏选集半屏浮层——底部向上滑出，复用竖屏设置抽屉（.drawer-mask/.drawer）样式；
          点遮罩关闭、选完集立即切播并关闭、面板内独立滚动且滚动条完全隐藏。 */}
      {epSheetOpen && (
        <div className="drawer-mask" onClick={() => setEpSheetOpen(false)}>
          <div className="ep-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-handle" />
            <div className="ep-head">
              <span>选集 · 共 {detail.episodes?.length ?? 0} 集</span>
              <span className="ep-toggle" onClick={() => setAsc((v) => !v)}>{asc ? '正序 ▾' : '倒序 ▴'}</span>
            </div>
            <div className="ep-sheet-grid" ref={epSheetRef}>
              {(() => {
                const list = detail.episodes ?? [];
                const order = asc ? list.map((_, i) => i) : list.map((_, i) => list.length - 1 - i);
                return order.map((i) => {
                  const ep = list[i];
                  const cur = i === episodeIndex;
                  return (
                    <button
                      key={i}
                      className={(cur ? 'active ep-cur' : '') + (ep?.locked ? ' locked' : '')}
                      onClick={() => { onSelectEpisode(i); setEpSheetOpen(false); }}
                    >
                      {ep?.locked ? '锁' : cleanEp(ep?.name, i)}
                      {cur && <span className="ep-dot" />}
                    </button>
                  );
                });
              })()}
            </div>
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
                  // V3.3.7 五：此前输出原始集名「第01集」，4~5 个字在正方块里挤成三行把格子撑高，
                  // 视觉上像「5 列正方块没生效」。改走 cleanEp，与竖屏三处保持一致。
                  return (
                    <button key={i} className={(i === episodeIndex ? 'active ep-cur' : '') + (ep?.locked ? ' locked' : '')} onClick={() => { onSelectEpisode(i); setEpOpen(false); }}>{ep?.locked ? '锁' : cleanEp(ep?.name, i)}{i === episodeIndex && <span className="ep-dot" />}</button>
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
// V3.3.7 六：样式参数由 settings.danmakuStyle 透传（此前弹幕写死 18px 白字，面板改了没反应）
function Danmaku({
  active, seed, items, style,
}: {
  active: boolean;
  seed: string;
  items: string[];
  style: { size: number; color: string; opacity: number; speed: number; area: number; outline: boolean };
}) {
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
      // area：弹幕出现区域占画面高度的百分比（100 = 全屏，50 = 只在上半屏）
      const top = 4 + Math.random() * Math.max(4, style.area - 8);
      // speed：100 = 基准 6~10 秒飘完；调大更快（时长更短）
      const base = 6 + Math.random() * 4;
      const dur = Math.max(2, base * (100 / Math.max(20, style.speed)));
      setBullets((b) => [...b, { id, text, top, dur }]);
      setTimeout(() => setBullets((b) => b.filter((x) => x.id !== id)), dur * 1000);
    }, 800);
    return () => clearInterval(timer);
  }, [active, seed, items, style.speed, style.area]);

  return (
    <div className="danmaku-layer">
      {bullets.map((b) => (
        <span
          key={b.id}
          className={'dm' + (style.outline ? ' dm-outline' : '')}
          style={{
            top: b.top + '%',
            animationDuration: b.dur + 's',
            fontSize: style.size + 'px',
            color: style.color,
            opacity: Math.max(0.1, Math.min(1, style.opacity / 100)),
          }}
        >{b.text}</span>
      ))}
    </div>
  );
}