import { MediaItem, aggregateHomeCached, expandSources } from '../../engine';
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
import { useSettings } from '../../lib/settings';
import { fetchHot, type HotData, type HotItem } from '../../lib/hot';

// v3.0.2 首页板块：电视剧 → 电影 → 综艺 → 动漫（v3.1.12 新增「动漫」块），互不串门
type SectionKey = 'hot' | 'movie' | 'variety' | 'anime';

// v3.1.12 国产内地判定（用户确认：港澳台不算内地，只留内地）。
//   地区字段明确海外/港澳台/含海外词 → 非国产；明确国产/内地/华语 → 国产；
//   地区字段存在但不明确 → 非国产（宁缺毋滥，避免漏网外国片）；无地区字段再走标题黑名单兜底。
// ⑯ v3.2.0 内置「仅显示内地影片」规则（硬编码常驻，不依赖任何开关）：
//   地区字段明确海外/港澳台/含英文名或拼音 → 一律排除；只明确 国产/内地/华语 才保留；
//   无地区字段再走标题黑名单兜底（含单字外语标记 + 用户自定义 blocklist），仍无法确认内地 → 当非国产排除。
function isDomestic(it: MediaItem, blocklist: string[]): boolean {
  const raw: any = it.raw ?? {};
  const area = String(raw.vod_area ?? raw.area ?? raw.region ?? '').toLowerCase();
  if (area) {
    if (/美|韩|日|泰|英|法|俄|德|意|西|印|欧|澳|港|台|海外|欧美|日韩|usa|uk|us|korea|japan|japanese|thai|england|france|russia|german|italy|spain|india|hongkong|taiwan|macau|hk|tw|mo/.test(area)) return false;
    if (/国产|大陆|内地|华语|中国|中剧|国产剧|china/.test(area)) return true;
    return false; // 地区字段存在但非明确国产（含 cn 等模糊值）→ 当作非国产
  }
  const t = it.title.toLowerCase();
  // A11：标题黑名单兜底 —— 只用「多字成词」的海外标记，不再用单字（旧版 '美/韩/日…' 会把
  //     「美好的生活」「韩国人」这类纯中文片名误判为外国片而排除，导致国产剧被误杀）。
  //     单字黑名单改由 settings.blocklist（用户可编辑）承担，这里只拦明确的外国剧/综艺词。
  const titleBlock = ['韩剧','韩综','美剧','美综','日剧','日综','泰剧','英剧','法剧','印度剧','欧美','日韩','海外','港剧','台剧','澳剧','好莱坞','korean','japanese','american','english','hollywood'];
  for (const w of titleBlock) if (w && t.includes(w)) return false;
  // A11：单字 blocklist 一律忽略（"美/韩"会误杀纯中文片名），只拦 2 字以上的自定义词
  for (const w of blocklist) if (w && w.length > 1 && t.includes(w.toLowerCase())) return false;
  return /[一-龥]/.test(it.title);
}

// 更新时间（用于"最新"排序）：优先 raw 里的各类时间字段
function updateTimeOf(it: MediaItem): number {
  const raw: any = it.raw ?? {};
  const t = String(raw.vod_time ?? raw.update_time ?? raw.pubdate ?? raw.time ?? raw.vod_year ?? '');
  const m = t.match(/(\d{4})[-/]?(\d{2})?[-/]?(\d{2})?/);
  if (m) {
    const y = +m[1];
    if (y > 1970 && y < 2100) return y * 10000 + (+m[2] || 0) * 100 + (+m[3] || 0);
  }
  return 0;
}

function classify(it: MediaItem): SectionKey | null {
  const g = (it.genre ?? '').toLowerCase();
  const raw: any = it.raw ?? {};
  const remarks = String(raw.vod_remarks ?? raw.type_name ?? it.artist ?? '').toLowerCase();
  const t = it.title.toLowerCase();
  const blob = g + ' ' + remarks + ' ' + t;
  // v3.1.12：动漫优先识别，避免「集数>1」的动漫被误归电视剧块
  if (/动漫|动画|anime|cartoon/.test(blob)) return 'anime';
  if (/综艺|variety|真人秀|选秀|脱口秀|访谈|脱口/.test(blob)) return 'variety';
  // A11：电视剧判定前移且更宽 —— 类型词 / 集数>1 / 标题含「第N集·全N集·更新至N」都算电视剧，
  //     避免「无 type 但确实是连续剧」被下面的兜底塞进电影，导致"电视剧空、电影有"。
  const seriesMarker = /电视剧|剧集|连续剧|电视连续剧|国产剧|台剧|港剧|drama|tvb|tv series|tvshow|\btv\b/;
  const hasEpisodes = /集$/.test(remarks)
    || (raw.vod_total && +raw.vod_total > 1)
    || /(第.+集|全\d+集|更新至\d+|共\d+集)/.test(t + ' ' + remarks);
  if (seriesMarker.test(blob) || hasEpisodes) return 'hot';
  if (/电影|movie|film|影院版/.test(g) || it.mediaType === 'video') return 'movie';
  // A11：兜底 —— 拿不到类型信息时，有集数当电视剧、否则当电影（旧版一律当电影会掏空电视剧块）
  if (raw.vod_total && +raw.vod_total > 1) return 'hot';
  return 'movie';
}

// 热度（用于排序）：优先源的 vod_hot/vod_hits/vod_score，回退评分；缺省 0
function heatOf(it: MediaItem): number {
  const raw: any = it.raw ?? {};
  const h = Number(raw.vod_hot ?? raw.vod_hits ?? raw.vod_score ?? it.score ?? 0);
  return isFinite(h) ? h : 0;
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
  const [homeItems, setHomeItems] = useState<MediaItem[]>([]);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState('');
  const [disclaimerOn, setDisclaimerOn] = useState(false);
  const disclaimerTimer = useRef<number | null>(null);

  // A12：豆瓣热门推荐（顶部 Banner + 四板块），与源站聚合相互独立，互不阻塞
  const [hotData, setHotData] = useState<HotData | null>(null);
  const [bannerIdx, setBannerIdx] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchHot().then((d) => { if (alive && d) setHotData(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // A12：Banner 自动轮播（4s 一切），仅在有 banner 时启用
  useEffect(() => {
    if (!hotData?.banner?.length) return;
    const id = window.setInterval(() => setBannerIdx((i) => (i + 1) % hotData!.banner.length), 4000);
    return () => window.clearInterval(id);
  }, [hotData]);

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
    const srcs = used.length ? used : sources;
    // Q26/Q27：先读缓存秒显（切 Tab / 重开不白等），再后台静默刷新
    aggregateHomeCached(srcs, {
      timeout: 20000,
      onPartial: (batch: MediaItem[]) => {
        if (cancelled || !batch.length) return;
        setHomeItems((prev) => {
          const m = new Map<string, MediaItem>();
          for (const it of prev) m.set(`${it.sourceId}|${it.id}`, it);
          for (const it of batch) {
            const k = `${it.sourceId}|${it.id}`;
            if (!m.has(k)) m.set(k, it);
          }
          return Array.from(m.values());
        });
        setHomeLoading(false);
      },
    }).then((r) => {
      if (cancelled) return;
      setHomeItems(r.items);
      if (!r.items.length && r.errors.length) {
        setHomeError(r.errors[0]?.message ?? '源暂未返回内容');
      } else {
        setHomeError('');
      }
      setHomeLoading(false);
    }).catch((e) => {
      if (!cancelled) setHomeError(e?.message ?? '加载失败');
      setHomeLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [sources, stations, activeStation]);

  // v3.1.12：四块各自按"国产 + 类型"过滤，并按「热度降序 → 上映时间/更新时间降序」排序
  // （热度最高的、上映最新的排前面）
  const domestic = homeItems.filter((it) => isDomestic(it, settings.blocklist ?? []));
  const sorted = [...domestic].sort((a, b) => {
    const dh = heatOf(b) - heatOf(a);
    if (dh !== 0) return dh;
    return updateTimeOf(b) - updateTimeOf(a);
  });
  const hot = sorted.filter((it) => classify(it) === 'hot').slice(0, 6);
  const movies = sorted.filter((it) => classify(it) === 'movie').slice(0, 6);
  const variety = sorted.filter((it) => classify(it) === 'variety').slice(0, 6);
  const anime = sorted.filter((it) => classify(it) === 'anime').slice(0, 6);
  // ⑬ 降级只从「已过滤国产」的 domestic 补，不再从全量（含外国）补，避免板块混入非国产
  const fallback = (arr: MediaItem[], key: SectionKey) =>
    arr.length ? arr : domestic.filter((it) => classify(it) === key).slice(0, 6);
  const hotFinal = fallback(hot, 'hot');
  const moviesFinal = fallback(movies, 'movie');
  const varietyFinal = fallback(variety, 'variety');
  const animeFinal = fallback(anime, 'anime');

  const enabledCount = sources.filter((s) => s.enabled).length;
  const activeStationName =
    activeStation === 'all' ? '全部站点' : (stations.find((s) => s.id === activeStation)?.name ?? '全部站点');

  const PosterCard = ({ it }: { it: MediaItem }) => {
    // ⑮ 封面多字段兜底：vod_pic / pic / poster / thumb / cover 任一可用
    const raw: any = it.raw ?? {};
    const coverUrl = it.cover || raw.vod_pic || raw.pic || raw.poster || raw.thumb || raw.cover || raw.pic_thumb || raw.vod_pic_thumb || '';
    const hasCover = !!coverUrl;
    return (
      <div className="pcard" onClick={() => onOpenDetail(it)}>
        <div className="pcover" style={{ background: hasCover ? undefined : gradientFor(it.title) }}>
          {hasCover ? <ProxiedImg src={coverUrl} alt="" fallbackText={it.title} /> : <span className="ph-big">{initial(it.title)}</span>}
          {it.episodes && it.episodes.length > 1 && <span className="eps">{it.episodes.length}集</span>}
          {it.score ? <span className="pscore">{it.score}</span> : null}
        </div>
        <div className="ptitle">{it.title}</div>
        <div className="psub">{it.year ?? ''} {it.genre ? '· ' + it.genre : ''}</div>
      </div>
    );
  };

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

  const HotRow = ({ title, items }: { title: string; items: HotItem[] }) => (
    <section className="row-section hot-row">
      <div className="row-head"><h3>{title}</h3></div>
      {items.length === 0 ? (
        <div className="empty sm">暂无内容</div>
      ) : (
        <div className="poster-grid">
          {items.map((it) => <HotPosterCard key={it.id} it={it} />)}
        </div>
      )}
    </section>
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

  // A12：顶部「豆瓣热门」轮播大卡（评分/标签/简介），点击触发搜索从已导入源解析可播内容
  const BannerBlock = () => {
    const list = hotData?.banner ?? [];
    if (!list.length) return null;
    const idx = bannerIdx % list.length;
    const b = list[idx];
    const hasCover = !!(b.pic && b.pic.length > 4);
    return (
      <section className="hot-banner" onClick={() => onSearch(b.name)}>
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

      {homeError && !homeLoading ? (
        <div className="empty sm" style={{ margin: '8px 14px' }}>{homeError}</div>
      ) : null}

      {/* A12：豆瓣热门推荐（顶部 Banner 轮播 + 四行热门），与源站聚合相互独立、互不阻塞 */}
      {hotData && (
        <>
          <BannerBlock />
          <HotRow title="热门电视剧" items={hotData.categories.tv} />
          <HotRow title="热门电影" items={hotData.categories.movie} />
          <HotRow title="热门综艺" items={hotData.categories.variety} />
          <HotRow title="热门动漫" items={hotData.categories.anime} />
        </>
      )}

      {homeLoading ? (
        // ⑩ 加载态：仅内容区，保留顶栏(logo/搜索/子站)与底部 TAB；背景跟随皮肤，中心转圈，无主题色条
        <div className="home-loading">
          <div className="home-spinner" />
          <span>加载中…</span>
        </div>
      ) : (
        <>
          <Section title="电视剧" items={hotFinal} />
          <Section title="电影" items={moviesFinal} />
          <Section title="综艺" items={varietyFinal} />
          <Section title="动漫" items={animeFinal} />
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
