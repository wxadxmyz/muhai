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
import { requestOrientation } from '../../lib/orientation';
import { isTV } from '../../lib/deviceMode';
import { downloadStore } from '../../lib/downloads';
import { toast } from '../../lib/toast';
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

const NAV: { key: NavTab; icon: any; label: string }[] = [
  { key: 'home', icon: 'home', label: '首页' },
  { key: 'search', icon: 'search', label: '搜索' },
  { key: 'live', icon: 'tv', label: '直播' },
  { key: 'history', icon: 'tab-history', label: '历史' },
  { key: 'settings', icon: 'settings', label: '设置' },
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
    setDetail(it);
    setSearchQuery(null);
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
      <nav className="tv-nav">
        <div className="brand"><span className="logo"><Icon name="film" size={20} /></span> 幕海</div>
        {NAV.map((n) => (
          <button
            key={n.key}
            className={'tv-nav-item' + (navTab === n.key ? ' active' : '')}
            data-focusable=""
            onClick={() => { setNavTab(n.key); if (n.key !== 'search') setSearchQuery(null); }}
          >
            <Icon name={n.icon} size={30} />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>

      <div className="tv-main">
        {!playing && detail && (
          <DetailTV item={detail} onPlay={(i, l) => playEpisode(detail, i, l)} onOffline={handleOffline} library={library} />
        )}

        {!playing && !detail && navTab === 'home' && <HomeTV onSearch={goSearch} />}
        {!playing && !detail && navTab === 'search' && searchQuery && (
          <SearchResultTV query={searchQuery} sources={sources} onOpenDetail={openDetail} library={library} />
        )}
        {!playing && !detail && navTab === 'search' && !searchQuery && (
          <SearchTV onSearch={goSearch} onRemote={() => setRemotePush('search')} />
        )}
        {!playing && !detail && navTab === 'live' && <LiveTV sources={sources} />}
        {!playing && !detail && navTab === 'history' && <HistoryTV library={library} onOpenDetail={openDetail} />}
        {!playing && !detail && navTab === 'settings' && <SettingsTV onReset={onReset} />}
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
        </div>
      )}

      {/* 搜索页「远程搜索」入口 → 扫码推送浮层 */}
      {remotePush && (
        <div className="tv-overlay" data-focus-root>
          <div className="tv-sheet" style={{ width: 'min(620px,92vw)' }}>
            <div className="tv-sheet-head">
              <h3>远程搜索 / 添加</h3>
              <button className="tv-action-btn" data-focusable="" onClick={() => setRemotePush(null)}><Icon name="x" size={18} /> 关闭</button>
            </div>
            <div className="tv-sheet-body">
              <RemotePushTV onClose={() => setRemotePush(null)} mode={remotePush} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
