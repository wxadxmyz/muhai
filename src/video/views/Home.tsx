import { MediaItem, aggregateHome, expandSources } from '../../engine';
import { useLibrary } from '../../lib/library';
import { SourceConfig } from '../../engine/types';
import { gradientFor, initial } from '../../lib/cover';
import { Icon } from '../../components/Icon';
import { ProxiedImg } from '../../components/ProxiedImg';
import { useEffect, useRef, useState } from 'react';
import {
  hasShownDisclaimer,
  markDisclaimerShown,
  onDisclaimerRequest,
  takePendingDisclaimer,
} from '../../lib/disclaimer';

// v2.5.0 首页板块：热播影视 → 电影 → 综艺（删除了原「为你推荐」分类切换）
type SectionKey = 'hot' | 'movie' | 'variety';

function classify(it: MediaItem): SectionKey | null {
  const g = (it.genre ?? '').toLowerCase();
  const t = it.title.toLowerCase();
  if (/综艺|variety|真人秀|选秀|脱口秀|访谈/.test(g + t)) return 'variety';
  if (/电影|movie|film/.test(g) || it.mediaType === 'video') return 'movie';
  return 'movie';
}

export function Home({
  sources,
  library,
  onOpenDetail,
  onSearch,
  onOpenSources,
  onDebug,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  onOpenDetail: (it: MediaItem) => void;
  onSearch: (q: string) => void;
  onOpenSources: () => void;
  onDebug: () => void;
}) {
  const [homeItems, setHomeItems] = useState<MediaItem[]>([]);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState('');
  const [disclaimerOn, setDisclaimerOn] = useState(false);
  const disclaimerTimer = useRef<number | null>(null);

  // v2.5.1 站点选择：列出 tvbox 源内的 spider 子站，单选用于首页聚合过滤
  const [stations, setStations] = useState<SourceConfig[]>([]);
  const [activeStation, setActiveStation] = useState<string>('all'); // 'all' 或子站 id
  const [sheetOpen, setSheetOpen] = useState(false);

  // 「使用须知」提示：添加源成功后弹一次（2s 自动消失），localStorage 保证只弹一次。
  useEffect(() => {
    const show = () => {
      if (hasShownDisclaimer()) return;
      setDisclaimerOn(true);
      markDisclaimerShown();
      try {
        localStorage.removeItem('disclaimer_pending');
      } catch {
        /* ignore */
      }
      if (disclaimerTimer.current) window.clearTimeout(disclaimerTimer.current);
      disclaimerTimer.current = window.setTimeout(() => setDisclaimerOn(false), 2000);
    };
    if (takePendingDisclaimer()) show();
    const off = onDisclaimerRequest(show);
    return () => {
      off();
      if (disclaimerTimer.current) window.clearTimeout(disclaimerTimer.current);
    };
  }, []);

  // 展开 tvbox 子站列表（供站点选择面板）
  useEffect(() => {
    if (sources.length === 0) {
      setStations([]);
      return;
    }
    expandSources(sources)
      .then((ex) => setStations(ex))
      .catch(() => setStations([]));
  }, [sources]);

  useEffect(() => {
    if (sources.length === 0) {
      setHomeItems([]);
      return;
    }
    let cancelled = false;
    setHomeLoading(true);
    setHomeError('');
    // 选了具体站点 → 只聚合该子站；否则聚合全部源
    const used = activeStation === 'all' ? sources : stations.filter((s) => s.id === activeStation);
    const p = aggregateHome(used.length ? used : sources, { timeout: 60000 });
    p.then((r) => {
      if (cancelled) return;
      setHomeItems(r.items);
      if (!r.items.length && r.errors.length) {
        setHomeError(r.errors[0]?.message ?? '源暂未返回内容');
      }
    })
      .catch((e) => {
        if (!cancelled) setHomeError(e?.message ?? '加载失败');
      })
      .finally(() => {
        if (!cancelled) setHomeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sources, stations, activeStation]);

  // 板块切分：热播影视取混排前 6（无 genre 或评分高优先），电影/综艺按 genre 归类
  const movies = homeItems.filter((it) => classify(it) === 'movie').slice(0, 6);
  const variety = homeItems.filter((it) => classify(it) === 'variety').slice(0, 6);
  const hot = homeItems.slice(0, 6);

  const enabledCount = sources.filter((s) => s.enabled).length;
  const activeStationName =
    activeStation === 'all' ? '全部站点' : (stations.find((s) => s.id === activeStation)?.name ?? '全部站点');

  const PosterCard = ({ it }: { it: MediaItem }) => (
    <div className="pcard" onClick={() => onOpenDetail(it)}>
      <div className="pcover" style={{ background: it.cover ? undefined : gradientFor(it.title) }}>
        {it.cover ? <ProxiedImg src={it.cover} alt="" /> : <span className="ph-big">{initial(it.title)}</span>}
        {it.episodes && it.episodes.length > 1 && <span className="eps">{it.episodes.length}集</span>}
        {it.score ? <span className="pscore">{it.score}</span> : null}
      </div>
      <div className="ptitle">{it.title}</div>
      <div className="psub">{it.year ?? ''} {it.genre ? '· ' + it.genre : ''}</div>
    </div>
  );

  const Section = ({ title, items }: { title: string; items: MediaItem[] }) => (
    <section className="row-section">
      <div className="row-head">
        <h3>{title}</h3>
      </div>
      {items.length === 0 ? (
        <div className="empty sm">{homeLoading ? '正在加载…' : '暂无内容'}</div>
      ) : (
        <div className="poster-grid">
          {items.map((it) => <PosterCard key={it.sourceId + it.id} it={it} />)}
        </div>
      )}
    </section>
  );

  const homeTop = (
    <div className="home-top v25">
      <div className="ht-logo">🌊 幕海</div>
      <button className="ht-search" onClick={() => onSearch('')}>
        <Icon name="search" size={16} />
        <span className="ht-search-ph">搜索电影/剧集/演员…</span>
      </button>
      <button className="ht-source" onClick={() => setSheetOpen(true)} title={activeStationName}>
        <span className="dot" />
        <span className="name">{activeStationName}</span>
        <span className="caret">▼</span>
      </button>
      <button className="ht-debug" onClick={onDebug} title="调试面板"><Icon name="bug" size={18} /></button>
    </div>
  );

  if (sources.length === 0) {
    return (
      <div className="view home">
        {homeTop}
        <div className="blank-state">
          <div className="blank-art"><Icon name="film" size={44} /></div>
          <h2>导入 JSON 源，开始看片</h2>
          <p className="muted">在「设置 → 源管理」里导入一个 JSON 源，<br />首页就会列出可看的影视与直播。</p>
          <button className="import-fab" onClick={onOpenSources}>
            <Icon name="plus" size={18} /> 导入 JSON 源
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view home v25">
      {homeTop}

      {homeError && !homeLoading ? (
        <div className="empty sm" style={{ margin: '8px 14px' }}>{homeError}</div>
      ) : null}

      <Section title="热播影视" items={hot} />
      <Section title="电影 · 高分精选" items={movies} />
      <Section title="综艺 · 热榜" items={variety} />

      {disclaimerOn && (
        <div className="home-disclaimer" onClick={() => setDisclaimerOn(false)}>
          <span className="home-disclaimer-icon">⚠</span>
          <span className="home-disclaimer-text">
            内容来自第三方公开接口，仅供本地检索与学习使用，请遵守当地法律法规。
          </span>
          <span
            className="home-disclaimer-close"
            onClick={(e) => {
              e.stopPropagation();
              setDisclaimerOn(false);
            }}
            aria-label="关闭"
          >
            ×
          </span>
        </div>
      )}

      {/* 站点选择面板：列出 tvbox 源内的 spider 子站，单选；不内置任何资源，数据来自用户导入的源 */}
      {sheetOpen && (
        <div className="station-mask" onClick={() => setSheetOpen(false)}>
          <div className="station-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="station-head">
              <span>选择站点</span>
              <button className="station-close" onClick={() => setSheetOpen(false)}>✕</button>
            </div>
            <div className="station-list">
              <div
                className={'station-item' + (activeStation === 'all' ? ' on' : '')}
                onClick={() => { setActiveStation('all'); setSheetOpen(false); }}
              >
                <span className="si-name">全部站点</span>
                <span className="si-sub">聚合所有已开启源</span>
                {activeStation === 'all' && <span className="si-check">✓</span>}
              </div>
              {stations.map((st) => (
                <div
                  key={st.id}
                  className={'station-item' + (activeStation === st.id ? ' on' : '')}
                  onClick={() => { setActiveStation(st.id); setSheetOpen(false); }}
                >
                  <span className="si-name">{st.name}</span>
                  <span className="si-sub">{((st as any).parentName ?? '') || '子站'}</span>
                  {activeStation === st.id && <span className="si-check">✓</span>}
                </div>
              ))}
            </div>
            <p className="station-note">站点来自你导入的源配置，App 不提供任何影视资源。</p>
          </div>
        </div>
      )}
    </div>
  );
}
