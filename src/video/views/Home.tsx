import { MediaItem, expandSources, SourceConfig } from '../../engine';
import { useLibrary } from '../../lib/library';
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
import { useSettings } from '../../lib/settings';
import { fetchHot, type HotData, type HotItem } from '../../lib/hot';
import { invoke } from '@tauri-apps/api/core';

type MoreCat = 'tv' | 'movie' | 'variety' | 'anime';

export function Home({
  sources,
  library,
  onOpenDetail,
  onSearch,
  onOpenSources,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  onOpenDetail: (it: MediaItem) => void;
  onSearch: (q: string) => void;
  onOpenSources: () => void;
}) {
  const { settings } = useSettings();
  const [disclaimerOn, setDisclaimerOn] = useState(false);
  const disclaimerTimer = useRef<number | null>(null);

  // A12：豆瓣热门推荐（顶部 Banner + 四板块），与源站聚合相互独立
  const [hotData, setHotData] = useState<HotData | null>(null);
  const [bannerIdx, setBannerIdx] = useState(0);
  const [moreView, setMoreView] = useState<{ cat: MoreCat; title: string } | null>(null);

  // V3.2.7 Q6：Banner 手动横滑状态
  const bannerTimer = useRef<number | null>(null);
  const bannerTouch = useRef<{ x: number; y: number } | null>(null);
  const bannerSuppressClick = useRef(false);
  // V3.2.7 Q6：自动轮播调度（可被手动横滑重置计时）
  const scheduleAuto = () => {
    if (bannerTimer.current) window.clearInterval(bannerTimer.current);
    if (!hotData?.banner?.length) return;
    bannerTimer.current = window.setInterval(() => {
      setBannerIdx((i) => {
        const next = (i + 1) % hotData!.banner.length;
        const nb = hotData!.banner[next];
        if (nb?.pic) invoke('fetchimage', { url: nb.pic }).catch(() => {}); // 预取下一张
        return next;
      });
    }, 4000);
  };

  // V3.2.5.1：站点选择器（独立 UI；不影响豆瓣区）
  const [stations, setStations] = useState<SourceConfig[]>([]);
  const [activeStation, setActiveStation] = useState<string>('all');
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    if (sources.length === 0) {
      setStations([]);
      return;
    }
    expandSources(sources)
      .then((ex) => setStations(ex))
      .catch(() => setStations([]));
  }, [sources]);
  const activeStationName =
    activeStation === 'all'
      ? '全部站点'
      : stations.find((s) => s.id === activeStation)?.name ?? '全部站点';

  useEffect(() => {
    let alive = true;
    fetchHot().then((d) => { if (alive && d) setHotData(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // A12：Banner 自动轮播调度入口（V3.2.7 Q6：切数据源时重排；scheduleAuto 可被手动横滑重置）
  useEffect(() => {
    if (!hotData?.banner?.length) return;
    scheduleAuto();
    return () => {
      if (bannerTimer.current) window.clearInterval(bannerTimer.current);
      bannerTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotData]);

  // V3.2.7 Q5/Q7：更多页打开时接管系统返回——首次返回关更多页回主页，再返回才退桌面
  useEffect(() => {
    if (!moreView) return;
    const prev = (window as any).__onAndroidBack;
    (window as any).__onAndroidBack = () => {
      setMoreView(null);
      return false; // JS 约定：false=已消费(拦截)，不退出 App
    };
    return () => {
      (window as any).__onAndroidBack = prev;
    };
  }, [moreView]);

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

  // A12：热门推荐海报卡（来自 hot.json，无 playUrl，点击触发搜索从已导入源解析可播内容）
  const HotPosterCard = ({ it }: { it: HotItem }) => {
    const hasCover = !!(it.pic && it.pic.length > 4);
    return (
      <div className="pcard hot-card" onClick={() => onSearch(it.name)} title={it.name}>
        <div className="pcover" style={{ background: hasCover ? undefined : gradientFor(it.name) }}>
          {hasCover ? <ProxiedImg src={it.pic!} alt="" fallbackText={it.name} /> : <span className="ph-big">{initial(it.name)}</span>}
          {it.area ? <span className="eps area">{(it.area || '').slice(0, 2)}</span> : null}
          {it.rating ? <span className="pscore">{it.rating}</span> : null}
        </div>
        <div className="ptitle">{it.name}</div>
        <div className="psub">{it.year ?? ''} {it.type ? '· ' + ({ tv: '剧', movie: '影', variety: '综', anime: '漫' }[it.type] ?? '') : ''}</div>
      </div>
    );
  };

  // V3.2.5 #2：每行固定 6 张、横排左右滑动；标题行最右加「更多」打开分类全屏页
  const HotRow = ({ title, items, onMore }: { title: string; items: HotItem[]; onMore?: () => void }) => (
    <section className="row-section hot-row">
      <div className="row-head">
        <h3>{title}</h3>
        {onMore && <button className="more-btn" onClick={onMore}>更多 ›</button>}
      </div>
      {items.length === 0 ? (
        <div className="empty sm">暂无内容</div>
      ) : (
        <div className="hot-row-scroll">
          {items.slice(0, 6).map((it) => <HotPosterCard key={it.id} it={it} />)}
        </div>
      )}
    </section>
  );

  // A12：顶部「豆瓣热门」轮播大卡；key 绑定 idx 实现切换淡入（V3.2.5 #3 crossfade）
  const BannerBlock = () => {
    const list = hotData?.banner ?? [];
    if (!list.length) return null;
    const idx = bannerIdx % list.length;
    const b = list[idx];
    const hasCover = !!(b.pic && b.pic.length > 4);
    // V3.2.7 Q6：手动左右横滑切 Banner（阈值 48px，横向占优才切）
    const onDown = (e: any) => {
      bannerTouch.current = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: any) => {
      const t = bannerTouch.current;
      bannerTouch.current = null;
      if (!t || !hotData?.banner?.length) return;
      const dx = e.clientX - t.x;
      const dy = e.clientY - t.y;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) {
        bannerSuppressClick.current = true; // 滑动后吞掉紧随的 click
        const n = hotData.banner.length;
        setBannerIdx((i) => {
          const next = (((dx < 0 ? i + 1 : i - 1) % n) + n) % n;
          const nb = hotData!.banner[next];
          if (nb?.pic) invoke('fetchimage', { url: nb.pic }).catch(() => {});
          return next;
        });
        scheduleAuto(); // 手动切换后重置自动轮播计时
      }
    };
    const onClickBanner = () => {
      if (bannerSuppressClick.current) {
        bannerSuppressClick.current = false;
        return;
      }
      onSearch(b.name);
    };
    return (
      <section className="hot-banner" onClick={onClickBanner} onPointerDown={onDown} onPointerUp={onUp}>
        <div className="hb-cover" style={{ background: hasCover ? undefined : gradientFor(b.name) }}>
          {hasCover ? <ProxiedImg src={b.pic!} alt="" fallbackText={b.name} /> : <span className="ph-big">{initial(b.name)}</span>}
          <div className="hb-mask" />
        </div>
        <div className="hb-info">
          <span className="hb-tag"><span className="db">豆瓣</span> 热门推荐 · 每日精选高分</span>
          <div className="hb-title">{b.name}{b.year ? `（${b.year}）` : ''}</div>
          {b.rating ? <div className="hb-rating">★ {b.rating}</div> : null}
          {b.desc ? <div className="hb-desc">{b.desc}</div> : null}
        </div>
        <div className="hb-dots">
          {list.map((_, i) => <span key={i} className={i === idx ? 'on' : ''} />)}
        </div>
      </section>
    );
  };

  const homeTop = (
    <div className="home-top v25">
      <div className="ht-logo">🌊 幕海</div>
      <button className="ht-search" onClick={() => onSearch('')}>
        <Icon name="search" size={16} />
        <span className="ht-search-ph">搜索电影/剧集/演员…</span>
      </button>
      {/* V3.2.5.1：站点选择按钮（独立 UI，与豆瓣区无关） */}
      <button className="ht-source" onClick={() => setSheetOpen(true)} title={activeStationName}>
        <span className="dot" />
        <span className="name">{activeStationName}</span>
        <span className="caret">▼</span>
      </button>
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

      {/* A12：豆瓣热门推荐（顶部 Banner 轮播 + 四行热门）；V3.2.5 #2 改为横排 + 更多页 */}
      {hotData && (
        <>
          <BannerBlock />
          <HotRow title="热门电视剧" items={hotData.categories.tv} onMore={() => setMoreView({ cat: 'tv', title: '热门电视剧' })} />
          <HotRow title="热门电影" items={hotData.categories.movie} onMore={() => setMoreView({ cat: 'movie', title: '热门电影' })} />
          <HotRow title="热门综艺" items={hotData.categories.variety} onMore={() => setMoreView({ cat: 'variety', title: '热门综艺' })} />
          <HotRow title="热门动漫" items={hotData.categories.anime} onMore={() => setMoreView({ cat: 'anime', title: '热门动漫' })} />
        </>
      )}

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

      {/* V3.2.5 #2：「更多」分类全屏页（仿 player-page 满屏覆盖，上下滑动） */}
      {moreView && hotData && (
        <div className="fullpage more-page">
          <div className="mp-head">
            <button className="mp-back" onClick={() => setMoreView(null)}>‹ 返回</button>
            <h3>{moreView.title}</h3>
          </div>
          <div className="mp-grid">
            {(hotData.categories[moreView.cat] ?? []).map((it) => <HotPosterCard key={it.id} it={it} />)}
          </div>
        </div>
      )}

      {/* V3.2.5.1：站点选择面板（来自已导入源，不内置任何资源） */}
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
