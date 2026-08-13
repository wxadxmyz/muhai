import { useEffect, useRef, useState } from 'react';
import { useSources } from '../store';
import { useLibrary } from '../lib/library';
import { usePlayback } from '../lib/playback';
import { usePlayer, player } from '../lib/playerStore';
import { useSettings } from '../lib/settings';
import { useGlobalShortcuts } from '../lib/shortcuts';
import { MediaItem } from '../engine/types';
import { alistClient } from '../lib/alistClient';
import { SearchView } from '../components/SearchView';
import { DebugPanel } from '../components/DebugPanel';
import { VideoPlayer } from './VideoPlayer';
import { DetailView } from './DetailView';
import { Home } from './views/Home';
import { CloudBrowse } from './views/CloudBrowse';
import { VideoLibrary } from './views/Library';
import { Live } from './views/Live';
import { SettingsPage } from './SettingsPage';
import { Disclaimer } from '../components/Disclaimer';
import { Icon } from '../components/Icon';

type Tab = 'home' | 'live' | 'history' | 'settings';
const ORDER: Tab[] = ['home', 'live', 'history', 'settings'];

export default function VideoApp() {
  const store = useSources('video');
  const library = useLibrary('video');
  const playback = usePlayback(store.sources, library);
  const { settings } = useSettings();
  const state = usePlayer();
  useGlobalShortcuts();

  const [tab, setTab] = useState<Tab>('home');
  const [detail, setDetail] = useState<MediaItem | null>(null);
  const [episodeIndex, setEpisodeIndex] = useState(0);
  const [line, setLine] = useState(0);
  const [startAt, setStartAt] = useState(0);
  const [showDebug, setShowDebug] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showCloud, setShowCloud] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);

  // 应用主题色 / 壁纸
  useEffect(() => {
    if (settings.themeColor) {
      document.documentElement.style.setProperty('--accent', settings.themeColor);
      document.documentElement.style.setProperty('--accent2', settings.themeColor);
    }
  }, [settings.themeColor]);

  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const dx = e.changedTouches[0].clientX - touchStart.current.x;
    const dy = e.changedTouches[0].clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      const i = ORDER.indexOf(tab);
      if (dx < 0 && i < ORDER.length - 1) setTab(ORDER[i + 1]);
      else if (dx > 0 && i > 0) setTab(ORDER[i - 1]);
    }
  };

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
    setDetail(it);
    setEpisodeIndex(0);
    setLine(0);
    if (!it.episodes || it.episodes.length === 0) playEpisode(it, 0, 0, true);
  };

  const closeVideo = () => {
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
    <div
      className="app video-theme"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
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
          影视
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
        )}

        {tab === 'home' && (
          <Home
            sources={store.sources}
            library={library}
            onOpenDetail={openDetail}
            onSearch={goSearch}
            onOpenSources={openSources}
          />
        )}

        {tab === 'live' && <Live sources={store.sources} onOpenSources={openSources} />}

        {tab === 'history' && (
          <VideoLibrary library={library} onOpen={openDetail} onSearch={goSearch} />
        )}

        {tab === 'settings' && <SettingsPage />}

        {searchOpen && (
          <div className="fullpage">
            <SearchView
              onClose={() => setSearchOpen(false)}
              sources={store.sources}
              onPlay={(it) => openDetail(it)}
              library={library}
              mediaType="video"
              placeholder="搜索电影 / 剧集 / 演员…"
              enableQueue={false}
              initialQuery={searchQuery}
            />
          </div>
        )}

        {detail && !playingVideo && (
          <DetailView
            detail={detail}
            episodeIndex={episodeIndex}
            onSelectEpisode={(i) => playEpisode(detail, i)}
            onBack={() => setDetail(null)}
          />
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
      {showDebug && <DebugPanel onClose={() => setShowDebug(false)} />}
    </div>
  );
}
