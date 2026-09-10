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
import { useCardGrid } from '../../lib/useCardGrid';

type MoreCat = 'tv' | 'movie' | 'variety' | 'anime';

// ── V3.3.0 #6：模块级数据缓存 ──
// Home 随底部 tab 切换会卸载重挂：组件 state 全丢 → hotData 重拉、图片重取 → 回主页整屏闪。
// 数据提到模块级，重挂时 useState 惰性初始化直接命中缓存，首帧就有完整内容，不再闪。
let hotCache: HotData | null = null;
let bannerImgCache: Record<string, string> = {};

// ── V3.3.0 #6：卡片/横排/更多页组件全部移到模块级 ──
// 之前这些组件定义在 Home 函数体内，Home 每次渲染（Banner 每 4s 切一次、bannerImgs
// 预载每张图更新一次……）都会产生全新的组件类型 → React 把旧卡片树整个卸载重挂，
// 卡片内 ProxiedImg 丢 state 首帧露渐变占位 = 用户看到的"滑 Banner 下面卡片闪一下"。
// 移到模块级后组件类型恒定，任何 state 变化只做最小更新，卡片树不再重挂、不再闪。

// 热门海报卡（V3.3.0 #1：卡宽/封面高由 JS 实测 px 内联，比例统一 3:4）
function HotPosterCard({ it, w, h, inlineTitle, onSearch }: {
  it: HotItem;
  w: number;
  h: number;
  inlineTitle?: boolean;
  onSearch: (q: string) => void;
}) {
  const hasCover = !!(it.pic && it.pic.length > 4);
  const coverSize = w > 0 ? { width: w, height: h } : undefined;
  return (
    <div
      className="pcard hot-card"
      style={w > 0 ? { width: w } : undefined}
      onClick={() => onSearch(it.name)}
      title={it.name}
    >
      <div
        className="pcover"
        style={hasCover ? coverSize : { ...coverSize, background: gradientFor(it.name) }}
      >
        {hasCover ? <ProxiedImg src={it.pic!} alt="" fallbackText={it.name} /> : <span className="ph-big">{initial(it.name)}</span>}
        {it.area ? <span className="eps area">{(it.area || '').slice(0, 2)}</span> : null}
        {it.rating ? <span className="pscore">{it.rating}</span> : null}
        {/* 名字条内嵌封面底部（更多页用），深色渐变 + 白字 */}
        {inlineTitle ? <div className="cover-name">{it.name}</div> : null}
      </div>
      {!inlineTitle && <div className="ptitle">{it.name}</div>}
      {!inlineTitle && <div className="psub">{it.year ?? ''} {it.type ? '· ' + ({ tv: '剧', movie: '影', variety: '综', anime: '漫' }[it.type] ?? '') : ''}</div>}
    </div>
  );
}

// 热门横排（V3.3.0 #1：JS 实测容器宽，3 卡 px 均分，缝 8px、左右 10px 边距）
function HotRow({ title, items, onMore, onSearch }: {
  title: string;
  items: HotItem[];
  onMore?: () => void;
  onSearch: (q: string) => void;
}) {
  const grid = useCardGrid({ cols: 3, gap: 8, pad: 10 });
  return (
    <section className="row-section hot-row">
      <div className="row-head">
        <h3>{title}</h3>
        {onMore && <button className="more-btn" onClick={onMore}>更多 ›</button>}
      </div>
      {items.length === 0 ? (
        <div className="empty sm">暂无内容</div>
      ) : (
        <div className="hot-row-scroll" ref={grid.ref} style={{ gap: 8, padding: '0 10px 4px' }}>
          {items.slice(0, 6).map((it) => (
            <HotPosterCard key={it.id} it={it} w={grid.cardW} h={grid.cardH} onSearch={onSearch} />
          ))}
        </div>
      )}
    </section>
  );
}

// 顶部「豆瓣热门」轮播大卡：多图层堆叠 crossfade——所有已加载的 banner 图常驻 DOM，
// 切换仅变 opacity（.hb-layer .35s），旧图垫底直到新图完全盖住，杜绝空窗露底闪黑
function BannerBlock({ list, idx, imgs, onSwitch, onSearch }: {
  list: HotItem[];
  idx: number;
  imgs: Record<string, string>;
  onSwitch: (next: number) => void;
  onSearch: (q: string) => void;
}) {
  const touch = useRef<{ x: number; y: number } | null>(null);
  const suppress = useRef(false);
  if (!list.length) return null;
  const i = idx % list.length;
  const b = list[i];
  // 手动左右横滑切 Banner（阈值 48px，横向占优才切）
  const onDown = (e: any) => {
    touch.current = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: any) => {
    const t = touch.current;
    touch.current = null;
    if (!t) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) {
      suppress.current = true; // 滑动后吞掉紧随的 click
      onSwitch(idx + (dx < 0 ? 1 : -1));
    }
  };
  const onClickBanner = () => {
    if (suppress.current) {
      suppress.current = false;
      return;
    }
    onSearch(b.name);
  };
  return (
    <section className="hot-banner" onClick={onClickBanner} onPointerDown={onDown} onPointerUp={onUp}>
      <div className="hb-cover" style={{ background: gradientFor(b.name) }}>
        {list.map((item, li) => {
          const src = item.pic ? imgs[item.pic] : undefined;
          if (!src) return null; // 未加载完的图层不渲染（旧图继续垫底）
          return (
            <img
              key={(item.pic ?? '') + li}
              className="hb-layer"
              src={src}
              alt=""
              style={{ opacity: li === i ? 1 : 0 }}
            />
          );
        })}
        {!(b.pic && imgs[b.pic!]) ? <span className="ph-big">{initial(b.name)}</span> : null}
        <div className="hb-mask" />
      </div>
      <div className="hb-info">
        <span className="hb-tag"><span className="db">豆瓣</span> 热门推荐 · 每日精选高分</span>
        <div className="hb-title">{b.name}{b.year ? `（${b.year}）` : ''}</div>
        {b.rating ? <div className="hb-rating">★ {b.rating}</div> : null}
        {b.desc ? <div className="hb-desc">{b.desc}</div> : null}
      </div>
      <div className="hb-dots">
        {list.map((_, di) => <span key={di} className={di === i ? 'on' : ''} />)}
      </div>
    </section>
  );
}

// 「更多」分类全屏页（V3.3.0 #4：JS 实测 3 卡 px 均分 + 显式封面高，杜绝卡片被拉长）
function MorePage({ title, items, onBack, onSearch }: {
  title: string;
  items: HotItem[];
  onBack: () => void;
  onSearch: (q: string) => void;
}) {
  const grid = useCardGrid({ cols: 3, gap: 8, pad: 10 });
  // 更多页打开时接管系统返回——首次返回关更多页回主页，再返回才退桌面
  useEffect(() => {
    const prev = (window as any).__onAndroidBack;
    (window as any).__onAndroidBack = () => {
      onBack();
      return false; // JS 约定：false=已消费(拦截)，不退出 App
    };
    return () => {
      (window as any).__onAndroidBack = prev;
    };
  }, [onBack]);
  return (
    <div className="fullpage more-page">
      <div className="mp-head">
        <button className="mp-back" onClick={onBack}>‹ 返回</button>
        <h3>{title}</h3>
      </div>
      <div className="mp-grid" ref={grid.ref} style={{ gap: 8, padding: '12px 10px' }}>
        {items.map((it) => (
          <HotPosterCard key={it.id} it={it} w={grid.cardW} h={grid.cardH} inlineTitle onSearch={onSearch} />
        ))}
      </div>
    </div>
  );
}

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
  // V3.3.0 #6：useState 惰性初始化——重挂时直接命中模块级缓存，首帧即完整内容
  const [hotData, setHotData] = useState<HotData | null>(() => hotCache);
  const [bannerIdx, setBannerIdx] = useState(0);
  // banner 图预加载缓存（base64）——显示层任意时刻都有一张实心图，杜绝切换空窗闪黑
  const [bannerImgs, setBannerImgs] = useState<Record<string, string>>(() => bannerImgCache);
  const bannerIdxRef = useRef(0); // 定时器/手势共用，避免闭包读到旧 idx
  const [moreView, setMoreView] = useState<{ cat: MoreCat; title: string } | null>(null);

  // V3.2.7 Q6：Banner 自动轮播调度（可被手动横滑重置计时）
  const bannerTimer = useRef<number | null>(null);

  // V3.3.0 #6：写缓存 + setState 同步走这里，模块缓存与组件 state 永远一致
  const putBannerImg = (pic: string, data: string) => {
    if (bannerImgCache[pic] === data) return;
    bannerImgCache = { ...bannerImgCache, [pic]: data };
    setBannerImgs(bannerImgCache);
  };

  // 切换到第 nextRaw 张——目标图已加载完才切；未加载先取图、加载完再切（期间旧图垫底不闪）
  const switchBanner = (nextRaw: number) => {
    const list = hotData?.banner ?? [];
    const n = list.length;
    if (!n) return;
    const next = ((nextRaw % n) + n) % n;
    const target = list[next];
    const go = () => {
      bannerIdxRef.current = next;
      setBannerIdx(next);
      scheduleAuto();
    };
    if (!target?.pic || bannerImgCache[target.pic]) { go(); return; }
    invoke<string>('fetchimage', { url: target.pic })
      .then((d) => { putBannerImg(target.pic!, d); go(); })
      .catch(() => go()); // 取图失败也切（有渐变兜底）
  };

  // 顺序预加载全部 banner 图（自动轮播 4s 间隔足够前几张就绪）
  useEffect(() => {
    let alive = true;
    (async () => {
      const list = hotData?.banner ?? [];
      for (const b of list) {
        if (!alive) return;
        if (!b.pic) continue;
        try {
          const d = await invoke<string>('fetchimage', { url: b.pic });
          if (!alive) return;
          putBannerImg(b.pic!, d);
        } catch { /* 单张失败忽略，该图层保留渐变兜底 */ }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotData]);

  // 自动轮播调度（可被手动横滑重置计时）
  const scheduleAuto = () => {
    if (bannerTimer.current) window.clearInterval(bannerTimer.current);
    if (!hotData?.banner?.length) return;
    bannerTimer.current = window.setInterval(() => {
      // 轮播也走 switchBanner——目标图未就绪会等加载完再切，不闪黑
      switchBanner(bannerIdxRef.current + 1);
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
    // V3.3.0 #6：缓存命中就不再整页重拉（回主页不再闪"从空到有"）
    if (hotCache) return;
    fetchHot().then((d) => {
      if (alive && d) {
        hotCache = d;
        setHotData(d);
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // A12：Banner 自动轮播调度入口（切数据源时重排；scheduleAuto 可被手动横滑重置）
  useEffect(() => {
    if (!hotData?.banner?.length) return;
    scheduleAuto();
    return () => {
      if (bannerTimer.current) window.clearInterval(bannerTimer.current);
      bannerTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotData]);

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

      {/* A12：豆瓣热门推荐（顶部 Banner 轮播 + 四行热门） */}
      {hotData && (
        <>
          <BannerBlock
            list={hotData.banner}
            idx={bannerIdx}
            imgs={bannerImgs}
            onSwitch={switchBanner}
            onSearch={onSearch}
          />
          <HotRow title="热门电视剧" items={hotData.categories.tv} onMore={() => setMoreView({ cat: 'tv', title: '热门电视剧' })} onSearch={onSearch} />
          <HotRow title="热门电影" items={hotData.categories.movie} onMore={() => setMoreView({ cat: 'movie', title: '热门电影' })} onSearch={onSearch} />
          <HotRow title="热门综艺" items={hotData.categories.variety} onMore={() => setMoreView({ cat: 'variety', title: '热门综艺' })} onSearch={onSearch} />
          <HotRow title="热门动漫" items={hotData.categories.anime} onMore={() => setMoreView({ cat: 'anime', title: '热门动漫' })} onSearch={onSearch} />
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

      {/* V3.2.5 #2：「更多」分类全屏页（V3.3.0 #4：JS 实测网格 + 名字条内嵌封面） */}
      {moreView && hotData && (
        <MorePage
          title={moreView.title}
          items={hotData.categories[moreView.cat] ?? []}
          onBack={() => setMoreView(null)}
          onSearch={onSearch}
        />
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
