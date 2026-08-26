import { useEffect, useRef, useState } from 'react';
import { useSources } from '../store';
import { useLibrary } from '../lib/library';
import { usePlayback } from '../lib/playback';
import { usePlayer, player } from '../lib/playerStore';
import { useSettings } from '../lib/settings';
import { useGlobalShortcuts } from '../lib/shortcuts';
import { useSwipeBack } from '../lib/swipeBack';
import { MediaItem } from '../engine/types';
import { alistClient } from '../lib/alistClient';
import { SearchView } from '../components/SearchView';
import { DebugPanel } from '../components/DebugPanel';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { VideoPlayer } from './VideoPlayer';
import { Home } from './views/Home';
import { CloudBrowse } from './views/CloudBrowse';
import { VideoLibrary } from './views/Library';
import { Live } from './views/Live';
import { SettingsPage } from './SettingsPage';
import { Disclaimer } from '../components/Disclaimer';
import { Icon } from '../components/Icon';
import SplashScreen from '../components/SplashScreen';
import { getCurrentWindow } from '@tauri-apps/api/window';

type Tab = 'home' | 'live' | 'history' | 'settings';

export default function VideoApp() {
  const store = useSources('video');
  const library = useLibrary('video');
  const playback = usePlayback(store.sources, library);
  const { settings } = useSettings();
  const state = usePlayer();
  useGlobalShortcuts();
  useSwipeBack();

  const [tab, setTab] = useState<Tab>('home');
  const [detail, setDetail] = useState<MediaItem | null>(null);
  const [episodeIndex, setEpisodeIndex] = useState(0);
  const [line, setLine] = useState(0);
  const [startAt, setStartAt] = useState(0);
  const [showDebug, setShowDebug] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showCloud, setShowCloud] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);
  const [settingsSub, setSettingsSub] = useState<string | null>(null);

  // 应用主题色 / 壁纸
  useEffect(() => {
    if (settings.themeColor) {
      document.documentElement.style.setProperty('--accent', settings.themeColor);
      document.documentElement.style.setProperty('--accent2', settings.themeColor);
    }
  }, [settings.themeColor]);

  // Android 原生返回键桥接：Kotlin MainActivity 通过 __onAndroidBack 调用此函数
  useEffect(() => {
    (window as any).__onAndroidBack = () => {
      const s = navRef.current;
      if ((window as any).__playerBack && (window as any).__playerBack()) return false;
      if (s.playingVideo) { closeVideo(); return false; }
      if (s.showDebug) { setShowDebug(false); return false; }
      if (s.showCloud) { setShowCloud(false); return false; }
      if (s.searchOpen) { setSearchOpen(false); return false; }
      if (s.detail) { setDetail(null); return false; }
      if (s.settingsSub) { setSettingsSub(null); return false; }
      if (s.tab !== 'home') { setTab('home'); return false; }
      return true; // 不拦截，交给系统退出
    };
    return () => { delete (window as any).__onAndroidBack; };
  }, []);

  // 手势返回：Android 返回键 / 侧滑逐级返回，而非直接退出到桌面
  const navRef = useRef({
    tab: 'home' as Tab,
    detail: null as MediaItem | null,
    playingVideo: false,
    searchOpen: false,
    settingsSub: null as string | null,
    showCloud: false,
    showDebug: false,
  });
  navRef.current = { tab, detail, playingVideo: !!detail && state.current?.mediaType === 'video', searchOpen, settingsSub, showCloud, showDebug };
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const un = await getCurrentWindow().onBackButton((event) => {
          const s = navRef.current;
          if ((window as any).__playerBack && (window as any).__playerBack()) { event.preventDefault(); return; }
          // v2.5.1 修复：优先委托当前页面的逐级返回钩子（Live/SearchView 等的二级、三级态）。
          // 钩子返回 false 表示已逐级退一层（拦截），true 表示无内部层级（放行）。
          if (typeof (window as any).__onAndroidBack === 'function') {
            try {
              const handled = (window as any).__onAndroidBack();
              if (handled === false) { event.preventDefault(); return; }
            } catch { /* 钩子异常忽略，继续外层逻辑 */ }
          }
          // 外层分级：播放器 → 调试 → 网盘 → 搜索 → 详情 → 设置子页 → 切回主页
          if (s.playingVideo) {
            event.preventDefault();
            closeVideo();
          } else if (s.showDebug) {
            event.preventDefault();
            setShowDebug(false);
          } else if (s.showCloud) {
            event.preventDefault();
            setShowCloud(false);
          } else if (s.searchOpen) {
            event.preventDefault();
            setSearchOpen(false);
          } else if (s.detail) {
            event.preventDefault();
            setDetail(null);
          } else if (s.settingsSub) {
            // 问题 #8 修复：先让设置页内部逐级退出（如关闭网盘编辑三级表单），
            // 仅当无内部子层时才关闭整个设置子页，避免侧滑直接回主页。
            if (typeof (window as any).__settingsInnerBack === 'function' && (window as any).__settingsInnerBack()) {
              event.preventDefault();
            } else {
              event.preventDefault();
              setSettingsSub(null);
            }
          } else if (s.tab !== 'home') {
            event.preventDefault();
            setTab('home');
          }
          // 否则不拦截，交给系统退出 App
        });
        unlisten = un;
      } catch {
        /* 不支持 onBackButton 的环境忽略 */
      }
    })();
    return () => unlisten?.();
  }, []);

  const playEpisode = (item: MediaItem, index = 0, line = 0, resume = false) => {
    const groups = (item.raw?.lineGroups as any[] | undefined) ?? [item.episodes ?? []];
    const eps = groups[line] ?? groups[0];
    const ep = eps[index] ?? eps[0];
    const playing: MediaItem = {
      ...item,
      episodes: eps,
      playUrl: ep?.url ?? item.playUrl,
      raw: { ...item.raw, episode: ep?.name, line },
    };
    const key = `${item.sourceId}:${item.id}`;
    const resumeAt = resume ? library.lib.watchProgress[key] || 0 : 0;
    library.addHistory(item);
    player.playItem(playing);
    setDetail(item);
    setEpisodeIndex(index);
    setLine(line);
    setStartAt(resumeAt);
  };

  const playCloudFile = async (item: MediaItem) => {
    const cfg = store.sources.find((s) => s.id === item.sourceId);
    let playUrl = item.episodes?.[0]?.url || '';
    if (cfg && item.raw?.alistPath) {
      const u = await alistClient.getUrl(cfg, item.raw.alistPath);
      playUrl = u || 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
    }
    const full: MediaItem = { ...item, playUrl, episodes: item.episodes?.map((e) => ({ ...e, url: playUrl })) };
    library.addHistory(full);
    player.playItem(full);
    setDetail(full);
    setEpisodeIndex(0);
    setLine(0);
    setStartAt(0);
  };

  const openDetail = (it: MediaItem) => {
    // 直进播放页（无详情页中转）：点击影视/搜索结果立即播放，逐级返回时回到上一层列表
    playEpisode(it, 0, 0, true);
  };

  const closeVideo = () => {
    // 清播放器并清 detail：从播放器逐级返回上层列表（主页/搜索结果），无详情页中转
    player.clearQueue();
    setDetail(null);
  };

  const goSearch = (q: string) => {
    setSearchQuery(q);
    setSearchOpen(true);
  };

  const openSources = () => setTab('settings');

  const playingVideo = state.current?.mediaType === 'video' && detail;
  const cloudPayload = () =>
    JSON.stringify({ kind: 'video', favorites: library.lib.favorites, history: library.lib.history, watchProgress: library.lib.watchProgress });

  return (
    <>
      <SplashScreen
        appName="幕海"
        iconSrc={import.meta.env.BASE_URL + 'icon.png'}
        gradient="linear-gradient(160deg, #3DB8FF 0%, #6A6BFF 45%, #3B1F7A 100%)"
      />
      <div
        className="app video-theme"
        style={
          settings.wallpaper
            ? {
                backgroundImage: `linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,.55)), url(${settings.wallpaper})`,
                backgroundSize: 'cover',
                backgroundAttachment: 'fixed',
              }
            : undefined
        }
      >
      <header className="topbar">
        <div className="brand">
          <span className="logo">
            <Icon name="film" size={20} />
          </span>{' '}
          幕海
        </div>
        <nav className="nav">
          <button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}>
            主页
          </button>
          <button className={tab === 'live' ? 'active' : ''} onClick={() => setTab('live')}>
            直播
          </button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
            历史
          </button>
        </nav>
        <div className="tb-right">
          <button className="icon" onClick={() => setShowDebug(true)} title="调试">
            <Icon name="bug" />
          </button>
          <button
            className="icon settings-btn"
            onClick={() => setTab('settings')}
            title="设置"
            aria-label="设置"
          >
            <Icon name="settings" size={20} />
          </button>
        </div>
      </header>

      <main className="main">
        {playingVideo && detail && (
          <div className="fullpage player-page">
          <ErrorBoundary name="播放器">
          <VideoPlayer
            detail={detail}
            episodeIndex={episodeIndex}
            line={line}
            startAt={startAt}
            onLineChange={(l) => playEpisode(detail, episodeIndex, l)}
            onSelectEpisode={(i) => playEpisode(detail, i)}
            onClose={closeVideo}
            library={library}
            sources={store.sources}
            settings={settings}
          />
          </ErrorBoundary>
          </div>
        )}

        {tab === 'home' && (
          <ErrorBoundary name="主页">
          <Home
            sources={store.sources}
            library={library}
            onOpenDetail={openDetail}
            onSearch={goSearch}
            onOpenSources={openSources}
            onDebug={() => setShowDebug(true)}
          />
          </ErrorBoundary>
        )}

        {tab === 'live' && (
          <ErrorBoundary name="直播">
          <Live sources={store.sources} onOpenSources={openSources} onDebug={() => setShowDebug(true)} />
          </ErrorBoundary>
        )}

        {tab === 'history' && (
          <ErrorBoundary name="历史">
          <VideoLibrary library={library} onOpen={openDetail} />
          </ErrorBoundary>
        )}

        {tab === 'settings' && (
          <ErrorBoundary name="设置">
          <SettingsPage sub={settingsSub} setSub={setSettingsSub} />
          </ErrorBoundary>
        )}

        {searchOpen && (
          <div className="fullpage">
            <ErrorBoundary name="搜索">
            <SearchView
              onClose={() => setSearchOpen(false)}
              sources={store.sources}
              onPlay={(it) => openDetail(it)}
              library={library}
              mediaType="video"
              placeholder="搜索电影 / 剧集 / 演员…"
              enableQueue={false}
              initialQuery={searchQuery}
              onDebug={() => setShowDebug(true)}
            />
            </ErrorBoundary>
          </div>
        )}

      </main>

      <nav className="bottom-nav">
        <button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}>
          <span className="ico">
            <Icon name="home" />
          </span>
          <span>主页</span>
        </button>
        <button className={tab === 'live' ? 'active' : ''} onClick={() => setTab('live')}>
          <span className="ico">
            <Icon name="cast" />
          </span>
          <span>直播</span>
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <span className="ico">
            <Icon name="library" />
          </span>
          <span>历史</span>
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <span className="ico">
            <Icon name="settings" />
          </span>
          <span>设置</span>
        </button>
      </nav>

      {showCloud && (
        <div className="fullpage">
          <div className="fullpage-head">
            <button className="icon" onClick={() => setShowCloud(false)}>
              <Icon name="arrow-left" />
            </button>
            <h3>网盘浏览</h3>
          </div>
          <div className="fullpage-body">
            <CloudBrowse sources={store.sources} onPlayFile={playCloudFile} />
          </div>
        </div>
      )}

      <Disclaimer onAccept={() => {}} />
      {showDebug && (
        <ErrorBoundary name="调试面板">
          <DebugPanel onClose={() => setShowDebug(false)} />
        </ErrorBoundary>
      )}
    </div>
    </>
  );
}
