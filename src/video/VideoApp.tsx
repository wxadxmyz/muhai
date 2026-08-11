import { useState } from 'react';
import { useSources } from '../store';
import { useLibrary } from '../lib/library';
import { usePlayback } from '../lib/playback';
import { usePlayer, player } from '../lib/playerStore';
import { useSettings } from '../lib/settings';
import { useGlobalShortcuts } from '../lib/shortcuts';
import { MediaItem } from '../engine/types';
import { alistClient } from '../lib/alistClient';
import { SourceManager } from '../components/SourceManager';
import { SearchView } from '../components/SearchView';
import { SettingsModal } from '../components/SettingsModal';
import { DebugPanel } from '../components/DebugPanel';
import { DownloadManager } from '../components/DownloadManager';
import { VideoPlayer } from './VideoPlayer';
import { DetailView } from './DetailView';
import { Home } from './views/Home';
import { CloudBrowse } from './views/CloudBrowse';
import { VideoLibrary } from './views/Library';
import { Icon } from '../components/Icon';

type Tab = 'home' | 'search' | 'cloud' | 'library' | 'sources';

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
  const [showSettings, setShowSettings] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);

  // resume=true 时恢复上次观看到的进度（跨集进度记忆）；选集/自动连播传 false 从头
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

  // 云盘文件：取直链后播放
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
    setTab('search');
  };

  const playingVideo = state.current?.mediaType === 'video' && detail;
  const cloudPayload = () =>
    JSON.stringify({ kind: 'video', favorites: library.lib.favorites, history: library.lib.history, watchProgress: library.lib.watchProgress });

  return (
    <div className="app video-theme">
      <header className="topbar">
        <div className="brand"><span className="logo"><Icon name="film" size={20} /></span> 影视</div>
        <nav className="nav">
          <button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}>首页</button>
          <button className={tab === 'search' ? 'active' : ''} onClick={() => { setSearchQuery(undefined); setTab('search'); }}>搜索</button>
          <button className={tab === 'cloud' ? 'active' : ''} onClick={() => setTab('cloud')}>网盘</button>
          <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>我的</button>
          <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}>音源管理</button>
        </nav>
        <div className="tb-right">
          <button className="icon" onClick={() => setShowDebug(true)} title="调试"><Icon name="bug" /></button>
          <button className="icon settings-btn" onClick={() => setShowSettings(true)} title="设置" aria-label="设置"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
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
          <Home sources={store.sources} library={library} onOpenDetail={openDetail} onSearch={goSearch} />
        )}

        {tab === 'search' && (
          <SearchView
            sources={store.sources}
            onPlay={(it) => openDetail(it)}
            library={library}
            mediaType="video"
            placeholder="搜索电影 / 剧集 / 演员…"
            enableQueue={false}
            initialQuery={searchQuery}
          />
        )}

        {tab === 'cloud' && <CloudBrowse sources={store.sources} onPlayFile={playCloudFile} />}

        {tab === 'library' && <VideoLibrary library={library} onOpen={openDetail} onOpenDebug={() => setShowDebug(true)} />}

        {tab === 'sources' && <SourceManager store={store} onOpenSettings={() => setShowSettings(true)} onOpenDebug={() => setShowDebug(true)} />}

        {detail && !playingVideo && (
          <DetailView detail={detail} episodeIndex={episodeIndex} onSelectEpisode={(i) => playEpisode(detail, i)} onBack={() => setDetail(null)} />
        )}
      </main>

      <nav className="bottom-nav">
        <button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}><span className="ico"><Icon name="home" /></span><span>首页</span></button>
        <button className={tab === 'search' ? 'active' : ''} onClick={() => { setSearchQuery(undefined); setTab('search'); }}><span className="ico"><Icon name="search" /></span><span>搜索</span></button>
        <button className={tab === 'cloud' ? 'active' : ''} onClick={() => setTab('cloud')}><span className="ico"><Icon name="film" /></span><span>网盘</span></button>
        <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}><span className="ico"><Icon name="library" /></span><span>我的</span></button>
        <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}><span className="ico"><Icon name="plug" /></span><span>音源</span></button>
        <button className="action" onClick={() => setShowSettings(true)}>
          <span className="ico" aria-hidden="true"><Icon name="settings" /></span>
          <span>设置</span>
        </button>
      </nav>

      {showSettings && <SettingsModal appName="影视" store={store} libraryPayload={cloudPayload} onClose={() => setShowSettings(false)} />}
      {showDebug && <DebugPanel onClose={() => setShowDebug(false)} />}
    </div>
  );
}
