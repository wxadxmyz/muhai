// TV 外壳（清单工作二核心）：左竖导航（首页/搜索/直播/历史/设置）+ 内容区路由 + 播放/详情编排。
// 复用 engine 数据层、useLibrary / useSettings / player，与手机端共用内核；仅 UI/交互按大屏遥控器重构。
import { useEffect, useRef, useState } from 'react';
import { SourceConfig, MediaItem, Episode, findSourceConfig, createSource } from '../../engine';
import { useLibrary } from '../../lib/library';
import { useSettings } from '../../lib/settings';
import { player } from '../../lib/playerStore';
import { useSources } from '../../store';
import { Icon } from '../../components/Icon';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { VideoPlayer } from '../VideoPlayer';
import { dispatchBack, pushBackHandler } from '../../lib/backStack';
import { isTvConfirmKey, focusElement } from '../../lib/focusNav';
import { requestOrientation } from '../../lib/orientation';
import { isTV } from '../../lib/deviceMode';
import { downloadStore } from '../../lib/downloads';
import { toast } from '../../lib/toast';
import { prewarmSuggestIndex } from '../../lib/suggestIndex';
import { getDeviceMode } from '../../lib/deviceMode';
import { HomeTV } from './HomeTV';
import { SearchTV } from './SearchTV';
import { SearchResultTV } from './SearchResultTV';
import { DetailTV } from './DetailTV';
import { LiveTV } from './LiveTV';
import { HistoryTV } from './HistoryTV';
import { SettingsTV } from './SettingsTV';
import { RemotePushTV } from './RemotePushTV';

type NavTab = 'home' | 'search' | 'live' | 'history' | 'settings';

// V4.3.1：首页右上角实时时钟（年月日 + 星期 + 带秒时间）。
// V4.4.0 #4/#6：播放器时钟改写影视仓风格——大字时间 + 网速；数秒后自动淡出，
// 任意按键（方向键/OK/返回）再显示并重新计时；首页/顶栏时钟保持常驻不变。
function TVClock({ className = '' }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());
  const isPlayer = className.includes('tv-player-clock');
  const [visible, setVisible] = useState(true);
  const hideTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  // #6：播放器时钟几秒后淡出、任意键再显示
  useEffect(() => {
    if (!isPlayer) return;
    const arm = () => {
      setVisible(true);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setVisible(false), 4000);
    };
    arm();
    const onKey = () => arm();
    const onPointer = () => arm();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.clearTimeout(hideTimer.current);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [isPlayer]);
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const p = (n: number) => String(n).padStart(2, '0');
  if (isPlayer) {
    return (
      <div className={`tv-clock tv-player-clock${visible ? '' : ' faded'}`} aria-hidden>
        <div className="pc-time">{`${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`}</div>
        <div className="pc-net">● 网络已连接</div>
      </div>
    );
  }
  return (
    <div className={`tv-clock ${className}`} aria-hidden>
      <div className="tv-clock-date">
        {`${now.getFullYear()}年${p(now.getMonth() + 1)}月${p(now.getDate())}日 ${wk[now.getDay()]}`}
      </div>
      <div className="tv-clock-time">
        {`${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`}
      </div>
    </div>
  );
}

// V4.3.5：顶栏 tab 图标对齐手机/桌面版（tab-home / tab-live / tab-history / tab-settings），
// 搜索沿用通用 search 图标（手机版搜索 tab 亦使用 search）。
const NAV: { key: NavTab; icon: any; label: string }[] = [
  { key: 'home', icon: 'tab-home', label: '首页' },
  { key: 'search', icon: 'search', label: '搜索' },
  { key: 'live', icon: 'tab-live', label: '直播' },
  { key: 'history', icon: 'tab-history', label: '历史' },
  { key: 'settings', icon: 'tab-settings', label: '设置' },
];

export function TVShell({
  sources,
  library,
  settings,
  onReset,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  settings: any;
  onReset: () => void;
}) {
  const [navTab, setNavTab] = useState<NavTab>('home');
  const [detail, setDetail] = useState<MediaItem | null>(null);
  const [playing, setPlaying] = useState(false);
  const [episodeIndex, setEpisodeIndex] = useState(0);
  const [line, setLineState] = useState(0);
  const [startAt, setStartAt] = useState(0);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [remotePush, setRemotePush] = useState<'source' | 'search' | null>(null);

  const navRef = useRef({ navTab, detail, playing, searchQuery, remotePush });
  const resultWrapRef = useRef<HTMLDivElement | null>(null);
  const prevDetailRef = useRef<MediaItem | null>(null);
  const lastFocusInResultRef = useRef<HTMLElement | null>(null);

  // V4.4.0 #5：进详情前记住结果页当前聚焦的卡片；从详情返回后把焦点还给原卡片（滚动位置随挂载保留）。
  useEffect(() => {
    const wasDetail = prevDetailRef.current;
    if (!wasDetail && detail && resultWrapRef.current) {
      // 刚进详情：抓取结果页里仍聚焦的元素
      const a = document.activeElement as HTMLElement | null;
      if (a && resultWrapRef.current.contains(a)) lastFocusInResultRef.current = a;
    }
    prevDetailRef.current = detail;
    if (wasDetail && !detail && navTab === 'search' && searchQuery && !playing) {
      const t = window.setTimeout(() => {
        const last = lastFocusInResultRef.current;
        // 校验旧节点仍在 DOM（结果页保持挂载，通常仍在）
        if (last && last.isConnected) focusElement(last);
        else if (resultWrapRef.current) focusElement(resultWrapRef.current.querySelector<HTMLElement>('[data-focusable]'));
      }, 60);
      return () => window.clearTimeout(t);
    }
  }, [detail, navTab, searchQuery, playing]);

  // 主题色注入（与 VideoApp 一致）
  useEffect(() => {
    if (settings.themeColor) {
      document.documentElement.style.setProperty('--accent', settings.themeColor);
      document.documentElement.style.setProperty('--accent2', settings.themeColor);
    }
  }, [settings.themeColor]);

  // 电视强制横屏（清单 §3.12：电视只有横屏，不进入竖屏播放器 UI）
  useEffect(() => {
    requestOrientation('landscape');
  }, []);

  // V4.4.0 #8：进软件光标直接落首页（顶栏「首页」tab）。
  // 免责声明显示期间不抢焦点（它有自己的自动聚焦与任意键进入），故以前端是否已接受声明为准。
  const homeTabRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!(settings as any)?.disclaimerAccepted) return;
    const t = window.setTimeout(() => focusElement(homeTabRef.current), 120);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // V4.3.8：启动时后台预热各源片名 → 本地拼音索引，供搜索联想覆盖源内容（不阻塞 UI）。
  useEffect(() => {
    const t = window.setTimeout(() => { prewarmSuggestIndex(sources).catch(() => {}); }, 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  // 返回键：栈式调度（dispatchBack 优先，未消费再走外壳分级）
  useEffect(() => {
    (window as any).__onAndroidBack = () => {
      if (dispatchBack()) return false;
      const s = navRef.current;
      if (s.playing) { closeVideo(); return false; }
      if (s.detail) { setDetail(null); return false; }
      if (s.remotePush) { setRemotePush(null); return false; }
      if (s.searchQuery) { setSearchQuery(null); return false; }
      if (s.navTab !== 'home') { setNavTab('home'); return false; }
      return true;
    };
    return () => { delete (window as any).__onAndroidBack; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        unlisten = await getCurrentWindow().onBackButton((event) => {
          const fn = (window as any).__onAndroidBack;
          if (typeof fn === 'function') {
            const handled = fn();
            if (handled === false) { event.preventDefault(); return; }
          }
        });
      } catch { /* 非 Tauri 环境忽略 */ }
    })();
    return () => unlisten?.();
  }, []);

  // 逐级返回（TV 无屏幕返回按钮，全靠遥控器返回键）
  useEffect(
    () =>
      pushBackHandler(() => {
        const s = navRef.current;
        if (s.playing) { closeVideo(); return true; }
        if (s.detail) { setDetail(null); return true; }
        if (s.remotePush) { setRemotePush(null); return true; }
        if (s.searchQuery) { setSearchQuery(null); return true; }
        if (s.navTab !== 'home') { setNavTab('home'); return true; }
        return false;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const playEpisode = (it: MediaItem, index = 0, ln = 0, resume = false) => {
    const groups = ((it.raw?.lineGroups as any[] | undefined) ?? [it.episodes ?? []]) as Episode[][];
    const eps = groups[ln] ?? groups[0];
    const ep = eps[index] ?? eps[0];
    const playingItem: MediaItem = {
      ...it,
      episodes: eps,
      playUrl: ep?.url ?? it.playUrl,
      raw: { ...it.raw, episode: ep?.name, line: ln },
    };
    const key = `${it.sourceId}:${it.id}:${index}`;
    const resumeAt = resume ? library.lib.watchProgress[key] || 0 : 0;
    library.addHistory(it);
    player.playItem(playingItem);
    setDetail(it);
    setEpisodeIndex(index);
    setLineState(ln);
    setStartAt(resumeAt);
    setPlaying(true);
  };

  const openDetail = async (it: MediaItem) => {
    // V4.4.0 #5：进详情「不清搜索态」——保留 searchQuery，返回时才能逐级回到结果页并还原卡片位置。
    // （旧版 V4.3.9 在此 setSearchQuery(null)，导致从结果页进详情后返回直接掉回搜索输入页。）
    setDetail(it);
    const cfg = findSourceConfig(sources, it.sourceId);
    if (!cfg) return;
    try {
      const src = createSource(cfg);
      if (!src.getDetail) return;
      const d = await src.getDetail(it.id);
      if (d && (d.id || (d as any).raw)) {
        const full: MediaItem = { ...it, ...d, id: it.id, sourceId: it.sourceId, raw: { ...it.raw, ...(d as any).raw } };
        if (!full.title) full.title = it.title || '未命名';
        if (!full.cover) full.cover = it.cover || '';
        if (!full.desc) full.desc = it.desc || '';
        if (!full.episodes?.length) full.episodes = it.episodes;
        setDetail(full);
      }
    } catch { /* 详情拉取失败保持列表项 */ }
  };

  const closeVideo = () => {
    player.clearQueue();
    setPlaying(false);
  };

  const goSearch = (q: string) => {
    setSearchQuery(q);
    setNavTab('search');
    setDetail(null);
  };

  const handleOffline = (it: MediaItem) => {
    try {
      if (it.playUrl || it.episodes?.length) {
        downloadStore.start(it);
        toast('已开始离线缓存（设置-下载管理查看）');
      } else {
        toast('请先进入播放页，再缓存当前集');
      }
    } catch { toast('离线缓存暂不可用'); }
  };

  // 镜像到 ref，供返回键闭包读取最新值
  navRef.current = { navTab, detail, playing, searchQuery, remotePush };

  return (
    <div className="tv" data-focus-root>
      {/* V4.3.9：搜索结果页 / 详情页隐藏整行顶栏（含 tab），界面更沉浸；
          返回完全靠遥控器返回键（外壳已有的分级返回逻辑：详情→关闭、结果→关闭）。 */}
      {!detail && !searchQuery && (
      <div className="tv-topnav">
        <div className="brand">
          <img src="/circle.apng" alt="幕海" className="brand-logo" />
          <span className="brand-txt">幕海</span>
        </div>
        <nav className="tv-tabs">
          {NAV.map((n) => (
            <button
              key={n.key}
              ref={n.key === 'home' ? homeTabRef : undefined}
              id={`tvtab-${n.key}`}
              className={'tab' + (navTab === n.key ? ' active' : '')}
              data-focusable=""
              data-nav-up={`#tvtab-${n.key}`}
              data-ok-handled=""
              onClick={() => { setNavTab(n.key); if (n.key !== 'search') setSearchQuery(null); }}
              onKeyDown={(e) => {
                if (isTvConfirmKey(e)) { e.preventDefault(); e.stopPropagation(); setNavTab(n.key); if (n.key !== 'search') setSearchQuery(null); }
              }}
            >
              <Icon name={n.icon} size={22} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <TVClock className="inline" />
      </div>
      )}

      <div className="tv-main">
        {!playing && detail && (
          <DetailTV item={detail} onPlay={(i, l) => playEpisode(detail, i, l)} onOffline={handleOffline} library={library} sources={sources} />
        )}

        {!playing && !detail && navTab === 'home' && <HomeTV onSearch={goSearch} />}
        {/* V4.4.0 #5：结果页在进详情时保持挂载（仅隐藏），返回后滚动位置与卡片焦点原样还原，
            不被卸载重建。detail/playing 时用 display:none 隐藏，DOM 与内部 state 保留。 */}
        {navTab === 'search' && searchQuery && (
          <div ref={resultWrapRef} style={{ height: '100%', display: (!playing && !detail) ? 'block' : 'none' }}>
            <SearchResultTV query={searchQuery} sources={sources} onOpenDetail={openDetail} library={library} />
          </div>
        )}
        {!playing && !detail && navTab === 'search' && !searchQuery && (
          <SearchTV onSearch={goSearch} onRemote={() => setRemotePush('search')} />
        )}
        {!playing && !detail && navTab === 'live' && <LiveTV sources={sources} />}
        {!playing && !detail && navTab === 'history' && <HistoryTV library={library} onOpenDetail={openDetail} />}
        {!playing && !detail && navTab === 'settings' && (
          <SettingsTV
            onReset={onReset}
            // V4.4.1 H1：扫码添加源成功后自动回首页（源已写入单例 store，首页自动读取新源刷新）。
            onAdded={() => { setDetail(null); setSearchQuery(null); setNavTab('home'); toast('影视源已添加，已返回首页'); }}
          />
        )}
      </div>

      {/* 播放器：全屏覆盖（电视全屏，不显示屏幕返回按钮） */}
      {playing && detail && (
        <div className="fullpage player-page" style={{ position: 'fixed', inset: 0, zIndex: 150, background: '#000' }}>
          <ErrorBoundary name="播放器">
            <VideoPlayer
              detail={detail}
              episodeIndex={episodeIndex}
              line={line}
              startAt={startAt}
              onLineChange={(l) => playEpisode(detail, episodeIndex, l)}
              onSelectEpisode={(i) => playEpisode(detail, i, line)}
              onClose={closeVideo}
              library={library}
              sources={sources}
              settings={settings}
              onOpenDownloads={() => toast('请在设置-下载管理查看')}
            />
          </ErrorBoundary>
          {/* V4.3.2：电视播放页右上角常驻带秒时钟（独立于播放器内部 overlay，置顶显示、不挡操作） */}
          <TVClock className="tv-player-clock" />
        </div>
      )}

      {/* 搜索页「远程搜索」入口 → 扫码推送浮层。
          V4.3.3：去掉浮层头部的多余「× 关闭」，电视端只保留组件内的「关闭」一个入口。 */}
      {remotePush && (
        <div className="tv-overlay" data-focus-root>
          <RemotePushTV
            onClose={() => setRemotePush(null)}
            mode={remotePush}
            onSearch={remotePush === 'search' ? (q: string) => { setRemotePush(null); goSearch(q); } : undefined}
          />
        </div>
      )}
    </div>
  );
}
