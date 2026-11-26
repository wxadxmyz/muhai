// TV 详情/选集页（清单 §3.6）：不自动播放，OK 进入播放器。
// 上方海报 + 片名 + 信息行；操作按钮一排：立即播放 / 离线缓存 / 收藏；
// 点「内容简介」弹居中白字浮层；下方剧集网格 + 线路切换。无屏幕返回按钮，靠遥控器返回键退出。
import { useEffect, useMemo, useRef, useState } from 'react';
import { MediaItem, Episode, SourceConfig } from '../../engine/types';
import { useLibrary } from '../../lib/library';
import { Icon } from '../../components/Icon';
import { focusElement } from '../../lib/focusNav';
import { pushBackHandler } from '../../lib/backStack';
import { tvItemPoster } from './common';
import { resolvePlay } from '../../player';
import { attachHlsWithBackend, detachHls } from '../../lib/hlsPlayer';
import { player } from '../../lib/playerStore';
import { registerMiniVideo, clearMiniVideo, getMiniVideo } from './miniVideoBus';
import { lineDisplayName, lineNetdiskKey } from '../../lib/lineName';
import { getNetdiskToken, type NetdiskKey } from '../../lib/netdisk';
import { NetdiskAuthTV } from './NetdiskAuthTV';

// V4.5.0：从 raw（CMS 原始字段）宽松提取影视仓详情页信息
function rawText(...vals: any[]): string {
  for (const v of vals) {
    if (v == null) continue;
    let s = String(v);
    try { s = s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '); } catch { /* ignore */ }
    s = s.replace(/\s+/g, ' ').trim();
    if (s) return s;
  }
  return '';
}

export function DetailTV({
  item,
  onPlay,
  onOffline,
  library,
  sources,
  initialIndex = 0,
  initialLine = 0,
  onIndexChange,
}: {
  item: MediaItem;
  onPlay: (index: number, line: number) => void;
  onOffline: (it: MediaItem) => void;
  library: ReturnType<typeof useLibrary>;
  sources: SourceConfig[];
  initialIndex?: number;
  initialLine?: number;
  onIndexChange?: (index: number, line: number) => void;
}) {
  const groups = useMemo(
    () => ((item.raw?.lineGroups as any[] | undefined) ?? [item.episodes ?? []]) as Episode[][],
    [item]
  );
  // V4.5.0 #8/#9：用大屏返回的集数/线路初始化，返回详情时接着选中的集，不回到第 1 集。
  const [line, setLine] = useState(initialLine);
  const [index, setIndex] = useState(initialIndex);
  const [showDesc, setShowDesc] = useState(false);
  const [reverse, setReverse] = useState(false); // V4.5.0 #10：选集倒序
  const playRef = useRef<HTMLButtonElement | null>(null);
  const descBtnRef = useRef<HTMLButtonElement | null>(null); // V4.4.3 #4：关闭简介后光标归位到「内容简介」按钮
  const descBodyRef = useRef<HTMLDivElement | null>(null); // V4.4.3 #3：简介正文滚动容器
  const miniVideoRef = useRef<HTMLVideoElement | null>(null);
  const miniSlotRef = useRef<HTMLDivElement | null>(null); // V4.5.1 方案 C：小窗 video 的原始容器（大屏归还用）
  const [miniPlaying, setMiniPlaying] = useState(false);
  // V4.5.1 #7：小窗加载期间纯黑 +「正在加载中」，不再先显示封面、再突然出画/出声。
  const [miniLoading, setMiniLoading] = useState(true);
  const activeEpRef = useRef<HTMLDivElement | null>(null); // V4.5.0 #9：进入详情焦点落选中集
  const epScrollRef = useRef<HTMLDivElement | null>(null); // V4.5.2 #10：选集独立滚动容器

  // V4.5.3 网盘授权：当前线路若是网盘且未授权，进入详情即弹窗；用户关掉后点线路可再次弹。
  const [authProvider, setAuthProvider] = useState<NetdiskKey | null>(null);
  const authDismissedRef = useRef<Set<string>>(new Set());
  const authKeyOf = (lineIdx: number) => `${item.id}:${lineIdx}`;
  const maybeAuth = (lineIdx: number, force = false) => {
    const k = lineNetdiskKey(item.raw, lineIdx);
    if (!k) { setAuthProvider(null); return; }
    if (getNetdiskToken(k)) { setAuthProvider(null); return; } // 已授权不弹
    const key = authKeyOf(lineIdx);
    if (!force && authDismissedRef.current.has(key)) return; // 用户已关闭该线路弹窗
    setAuthProvider(k);
  };

  const eps = groups[line] ?? groups[0] ?? [];
  const fav = library.isFavorite(item);

  // V4.5.1 #6：分段容量随列数联动——选集短名一行 6 个则每段 42，长名一行 4 个则每段 40，
  // 保证每段正好铺满整数行。long 判定与下方网格 class 用同一结果。
  const epLong = eps.some((e) => (e?.name || '').replace(/\D/g, '').length >= 6);
  const SEG = epLong ? 40 : 42;
  const [seg, setSeg] = useState(() => Math.floor(initialIndex / (epLong ? 40 : 42)));

  // V4.5.0 #8/#9 + V4.5.2 #10 + V4.5.3 #13：进入详情——焦点落在选中那一集（保留续播进度，选 B），
  // 并把它滚到选集滚动区靠上第二行；切分段/从大屏返回时也重新定位，左上角「第X集」由播放页 epName 显示。
  // 用双 rAF 确保在网格渲染完成后再滚动，避免 120ms 定时器在慢机型上网格未就绪导致定位失败。
  useEffect(() => {
    let raf2 = 0;
    const t = window.setTimeout(() => {
      const place = () => {
        const ep = activeEpRef.current;
        focusElement(ep || playRef.current);
        if (ep && epScrollRef.current) {
          const box = epScrollRef.current;
          // 让当前集处于视口靠上位置（顶部留一行，即「第二行」）
          const top = ep.offsetTop - 58 - 9; // 58=行高, 9=gap；往上让一行
          box.scrollTop = Math.max(0, top);
        }
      };
      // 双帧：第一帧等 React 提交，第二帧等布局完成，确保 offsetTop 准确
      raf2 = window.requestAnimationFrame(() => { raf2 = window.requestAnimationFrame(place); });
    }, 120);
    return () => { window.clearTimeout(t); if (raf2) window.cancelAnimationFrame(raf2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, initialIndex, initialLine, index, seg]);

  // V4.5.3 网盘授权：进入详情（或详情 raw 拉全、切线路）时检测当前线路网盘是否未授权 → 弹窗。
  // 详情是异步拉全的（lineNames 可能后到），依赖 item.raw 确保识别到网盘线路后再弹。
  useEffect(() => { maybeAuth(line); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [item.id, item.raw, line]);

  // V4.5.0 #8：集数/线路变化时通知外壳记录，切集返回可直接续播+焦点还原。
  useEffect(() => { onIndexChange?.(index, line); }, [index, line]);
  // 切换影片时重置倒序/分段（沿用初始集所在分段）
  useEffect(() => { setReverse(false); setSeg(Math.floor(initialIndex / SEG)); }, [item.id]);

  // V4.4.2 #12/#17：左上角小窗「真实播放」+ 无缝续播。
  //  - 带声音：先静音保证自动播放成功，play() 成功后立即取消静音（TV WebView 通常允许有声播放）。
  //  - 无缝续播：起播后从 library.watchProgress[resumeKey] 读进度 seek 过去；播放中节流写回，
  //    这样进全屏（VideoPlayer 读同一 resumeKey）与返回详情（小窗读同一 resumeKey）进度完全衔接。
  //  - 复用 HTML5 <video> + 现有 HLS 能力（不打包原生内核，APK 不增大）。
  const resumeKey = `${item.sourceId}:${item.id}:${index}`;
  useEffect(() => {
    const v = miniVideoRef.current;
    if (!v) return;
    // V4.5.1 方案 C：把小窗 video  expose 给大屏播放器复用（同一 DOM 节点，零重新加载）
    if (miniSlotRef.current) registerMiniVideo({ video: v, slot: miniSlotRef.current, key: resumeKey });
    let alive = true;
    let timeUpdateHandler: (() => void) | null = null;
    let lastSave = 0;
    setMiniPlaying(false);
    setMiniLoading(true); // V4.5.1 #7：切集/进详情先回到黑屏加载态
    (async () => {
      try {
        const ep = eps[index];
        const seed: MediaItem = {
          ...item,
          playUrl: ep?.url || item.playUrl,
          raw: { ...item.raw, episode: ep?.name, line },
        };
        const resolved = await resolvePlay(seed, sources);
        if (!alive || !resolved.playUrl) return;
        await attachHlsWithBackend(v, resolved.playUrl, {
          headers: resolved.raw?.headers as Record<string, string> | undefined,
          onError: () => { if (alive) setMiniPlaying(false); },
        });
        if (!alive) return;
        v.muted = true; // 先静音确保自动播放成功
        v.loop = true;
        v.playsInline = true;
        // V4.4.2 #17：从上次进度续播（全屏/小窗共用 resumeKey）
        try {
          // V4.4.3 跨源同片续播：本源无进度时按片名回退（上次在别的源看过同一部片）
          let saved = library.lib.watchProgress[resumeKey] ?? 0;
          if (saved <= 0) {
            const tp = library.getTitleProgress(item.title);
            if (tp && tp.sec > 0 && tp.sourceId !== item.sourceId) saved = tp.sec;
          }
          const applySeek = () => {
            if (!alive || saved <= 1 || !isFinite(v.duration) || v.duration <= 0) return;
            if (saved >= v.duration - 3) return; // 接近片尾不跳
            try { v.currentTime = saved; } catch { /* ignore */ }
          };
          if (v.readyState >= 1) applySeek();
          else v.addEventListener('loadedmetadata', applySeek, { once: true });
        } catch { /* ignore */ }
        try {
          await v.play();
          if (alive) { setMiniPlaying(true); setMiniLoading(false); }
          // V4.5.1 #4：小窗与大屏音量统一交给系统媒体音量——两端 video 固定 volume=1、只切静音。
          try { v.volume = 1; v.muted = false; } catch { /* ignore */ }
        } catch { /* 自动播放被拦则停在黑屏加载态 */ }
        // V4.4.2 #17：播放中节流写回进度（5 秒一次），供进全屏/返回时无缝衔接
        timeUpdateHandler = () => {
          // V4.5.1 方案 C：共用 video 时，大屏进度条/时钟依赖 player store，实时同步（不受 5 秒节流限制）
          try {
            player.setProgress(v.currentTime);
            if (v.duration > 0) player.setDuration(v.duration);
          } catch { /* ignore */ }
          const now = Date.now();
          if (!alive || now - lastSave < 5000) return;
          const t = v.currentTime;
          if (!(t > 0) || !isFinite(t)) return;
          lastSave = now;
          library.setProgressBoth(resumeKey, t, `${item.sourceId}:${item.id}`, index, item.title, item.sourceId);
        };
        v.addEventListener('timeupdate', timeUpdateHandler);
      } catch { /* 解析失败：保持封面底图，不影响进详情/点播放 */ }
    })();
    return () => {
      alive = false;
      if (timeUpdateHandler) { try { v.removeEventListener('timeupdate', timeUpdateHandler); } catch { /* ignore */ } }
      // 离开小窗前补写一次当前进度（进全屏时进度不丢）
      try {
        if (v.currentTime > 0 && isFinite(v.currentTime)) {
          library.setProgressBoth(resumeKey, v.currentTime, `${item.sourceId}:${item.id}`, index, item.title, item.sourceId);
        }
      } catch { /* ignore */ }
      try { detachHls(v); v.pause(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.sourceId, index, line]);

  // V4.4.3 #4：关闭简介时把光标还给「内容简介」按钮（不再丢失焦点）
  const closeDesc = () => {
    setShowDesc(false);
    window.setTimeout(() => focusElement(descBtnRef.current), 40);
  };

  // 简介浮层：焦点陷阱 + 返回键关闭
  // V4.4.5 #9：打开即聚焦「关闭」由按钮上的 data-autofocus + focusNav 的 MutationObserver 完成；
  // 正文已去掉 data-focusable，弹层内唯一可聚焦元素就是关闭，方向键不会把焦点移到正文。
  useEffect(() => {
    if (!showDesc) return;
    return pushBackHandler(() => { closeDesc(); return true; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDesc]);

  // V4.4.3 #3：简介正文支持遥控器 ↑↓ / PageUp/PageDown 上下滚动（长简介可看全）。
  // 焦点落在正文容器上（data-focusable + tabIndex），方向键由本处理器接管滚动，阻止冒泡到焦点导航。
  const onDescKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const box = descBodyRef.current;
    if (!box) return;
    const k = e.key;
    const code = (e as any).keyCode || 0;
    const step = 80;
    if (k === 'ArrowDown' || k === 'Down' || code === 20) { e.stopPropagation(); e.preventDefault(); box.scrollTop += step; }
    else if (k === 'ArrowUp' || k === 'Up' || code === 19) { e.stopPropagation(); e.preventDefault(); box.scrollTop -= step; }
    else if (k === 'PageDown' || code === 93) { e.stopPropagation(); e.preventDefault(); box.scrollTop += box.clientHeight; }
    else if (k === 'PageUp' || code === 92) { e.stopPropagation(); e.preventDefault(); box.scrollTop -= box.clientHeight; }
  };

  // V4.5.0 #14：影视仓详情信息——来源 / 演员 / 导演 / 播放地址 / 简介（过长省略号）
  const r = (item.raw ?? {}) as any;
  const infoSource = rawText(item.sourceName, r.vod_from, r.source, r.source_name);
  const infoYear = rawText(item.year, r.vod_year, r.year);
  const infoArea = rawText(r.vod_area, r.area, (item.raw as any)?.area);
  const infoType = rawText(r.type_name, r.vod_class, item.genre, r.type, (item.raw as any)?.type);
  const infoRes = rawText(r.vod_resolution, r.resolution);
  const infoActor = rawText(r.vod_actor, r.actor, r.actors, item.artist);
  const infoDirector = rawText(r.vod_director, r.director, r.daoyan);
  const infoPlayUrl = rawText(eps[index]?.url, item.playUrl, r.vod_play_url);
  const infoDesc = rawText(item.desc, r.vod_content, r.vod_blurb, r.content);

  const { cover, name } = tvItemPoster(item);

  return (
    <div className="tv-detail">
      {/* V4.4.1：上排 = 播放小窗 + 片名/信息/胶囊；下排 = 线路 + 选集（按 UI 定稿移到播放窗与简介下方） */}
      <div className="dt-top">
        {/* 播放小窗口（封面做底 + 中央播放按钮，点整窗即播） */}
        <div
          ref={miniSlotRef}
          className="tv-detail-player"
          data-focusable=""
          onClick={() => onPlay(index, line)}
          onKeyDown={(e) => { const c = (e as any).keyCode || 0; if (['Enter', 'OK', 'Select', ' '].includes(e.key) || c === 13 || c === 23 || c === 66) { e.preventDefault(); onPlay(index, line); } }}
          role="button"
          title="立即播放"
        >
          {cover ? <img src={cover} alt="" /> : <div className="ph-big" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 90, color: '#fff' }}>{name.slice(0, 1)}</div>}
          {/* V4.4.1 D1：小窗内嵌 <video> 真实循环预览；起播成功盖住封面底图 */}
          <video
            ref={miniVideoRef}
            className={'tv-detail-mini-video' + (miniPlaying ? ' on' : '')}
            muted playsInline loop preload="metadata"
          />
          {/* V4.5.1 #7：加载期间纯黑遮罩盖住封面 + 转圈 +「正在加载中」，起播成功后淡出 */}
          {miniLoading && (
            <div className="mini-loading">
              <span className="vp-spinner" />
              <span>正在加载中…</span>
            </div>
          )}
          <div className="dshade" />
          <div className="dplay"><Icon name="play" size={38} /></div>
          {/* V4.4.5 #8：去掉「XX·立即播放」文字标签，让播放画面本身成为焦点高亮（文字会抢视觉焦点） */}
        </div>

        <div className="tv-detail-body">
          <h1 className="tv-detail-title">{name}</h1>
          {/* V4.5.0 #14：影视仓详情信息 —— 来源 / 年份 / 地区 / 类型 / 演员 / 导演 / 播放地址 / 简介 */}
          <div className="vinfo">
            <div className="vinfo-line"><span className="vk">来源：</span><span className="vv">{infoSource || '未知'}{infoRes ? ` | ${infoRes}` : ''}{infoYear ? `　年份：${infoYear}` : ''}{infoArea ? `　地区：${infoArea}` : ''}{infoType ? `　类型：${infoType}` : ''}</span></div>
            {infoActor && <div className="vinfo-line"><span className="vk">演员：</span><span className="vv">{infoActor}</span></div>}
            {infoDirector && <div className="vinfo-line"><span className="vk">导演：</span><span className="vv">{infoDirector}</span></div>}
            {infoPlayUrl && <div className="vinfo-line"><span className="vk">播放地址：</span><span className="vv vv-ellipsis">{infoPlayUrl}</span></div>}
            {infoDesc && <div className="vinfo-line"><span className="vk">内容简介：</span><span className="vv vv-clamp">{infoDesc}</span></div>}
          </div>
          {/* V4.5.0 #10：胶囊按影视仓 —— 快速搜索(改为倒序) / 加入收藏 / 内容简介（不要播放按钮） */}
          <div className="tv-pillrow">
            <button ref={playRef} className="tv-pill p-play" data-focusable="" onClick={() => setReverse((v) => !v)}>
              <Icon name="list" size={20} /> {reverse ? '顺序' : '倒序'}
            </button>
            <button className={'tv-pill p-fav' + (fav ? ' active' : '')} data-focusable="" onClick={() => library.toggleFavorite(item)}>
              <Icon name={fav ? 'heart-filled' : 'heart'} size={20} /> {fav ? '已收藏' : '加入收藏'}
            </button>
            <button ref={descBtnRef} className="tv-pill p-desc" data-focusable="" onClick={() => setShowDesc(true)}>
              <Icon name="file-text" size={20} /> 内容简介
            </button>
          </div>
        </div>
      </div>

      {/* V4.5.2 #10：上固定区（线路 + 分段）不滚动；下独立滚动区只放选集网格 */}
      <div className="dt-fixed">
        {groups.length > 1 && (
          <div className="tv-line-row dt-row">
            <div className="line-tabs">
              {groups.map((g, i) => (
                <span
                  key={i}
                  className={'tv-line-pill' + (line === i ? ' active' : '')}
                  data-focusable=""
                  onClick={() => { setLine(i); setIndex(0); setSeg(0); maybeAuth(i, true); }}
                  role="button"
                >
                  {/* V4.5.3：用站点自己的线路名（网盘站套谐音），不再写死「线路N」 */}
                  {lineDisplayName(item.raw, i)}
                  {g.length ? `（${g.length}）` : ''}
                </span>
              ))}
            </div>
          </div>
        )}
        {/* V4.5.0 #13：分段区间标签 1-40 / 41-80 …（影视仓） */}
        {eps.length > SEG && (
          <div className="tv-ep-segs">
            {Array.from({ length: Math.ceil(eps.length / SEG) }, (_, s) => (
              <span
                key={s}
                className={'tv-ep-seg' + (seg === s ? ' active' : '')}
                data-focusable=""
                onClick={() => setSeg(s)}
                role="button"
              >
                {s * SEG + 1}-{Math.min((s + 1) * SEG, eps.length)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* V4.5.3 #11：无分段行时，选集区补上间距，避免集数贴着小窗/线路行 */}
      <div className={'dt-ep-scroll' + (eps.length > SEG ? '' : ' no-segs')} ref={epScrollRef} data-scroll>
        <div className={'tv-ep-grid' + (epLong ? ' long' : '')}>
          {eps.length === 0 ? (
            <div className="tv-empty">暂无选集</div>
          ) : (() => {
            // 当前分段内的全局索引列表；倒序时反转显示但保留真实 index
            const start = seg * SEG;
            const end = Math.min(start + SEG, eps.length);
            const ids: number[] = [];
            for (let i = start; i < end; i++) ids.push(i);
            if (reverse) ids.reverse();
            // V4.5.3 #14：集元素补网格坐标（每行 6 个，长名 4 个），方向键按网格移动、配合 focusEl 自动滚入视口；
            // 保持「只移光标、OK 才切集」的现有设计，不改变点击才切集的行为。
            const COLS = epLong ? 4 : 6;
            return ids.map((i, pos) => (
              <div
                key={i}
                ref={index === i ? activeEpRef : undefined}
                className={'tv-ep' + (index === i ? ' active' : '')}
                data-focusable=""
                data-grid-col={pos % COLS}
                data-grid-row={Math.floor(pos / COLS)}
                onClick={() => { setIndex(i); onIndexChange?.(i, line); onPlay(i, line); }}
                role="button"
              >
                {eps[i]?.name || `第${i + 1}集`}
              </div>
            ));
          })()}
        </div>
      </div>

      {showDesc && (
        <div className="tv-overlay" data-focus-root>
          {/* V4.4.5 #9：↑↓ 滚动监听放在 sheet 上（焦点锁在关闭按钮，方向键冒泡到这里被拦截，
              不再让 focusNav 把焦点从「关闭」移到正文）。 */}
          <div className="tv-sheet" style={{ width: 'min(680px, 90vw)' }} onKeyDown={onDescKey}>
            <div className="tv-sheet-head">
              <h3>{name} · 简介</h3>
              <button className="tv-action-btn" data-focusable="" data-autofocus="" onClick={closeDesc}>
                关闭
              </button>
            </div>
            {/* V4.4.5 #9：正文不再可聚焦，只是滚动内容；光标始终在「关闭」上 */}
            <div ref={descBodyRef} className="tv-sheet-body">
              <p className="tv-detail-desc" style={{ margin: 0, display: 'block', WebkitLineClamp: 'unset' }}>
                {item.desc || '暂无简介信息。'}
              </p>
              <div style={{ marginTop: 16, fontSize: 15, color: 'var(--muted)' }}>按遥控器 ↑ / ↓ 键上下滚动查看完整简介</div>
            </div>
          </div>
        </div>
      )}

      {/* V4.5.3 网盘授权：当前线路网盘未授权时进入即弹；返回键/登录成功后关闭，登录后自动重试当前集 */}
      {authProvider && !showDesc && (
        <NetdiskAuthTV
          provider={authProvider}
          onClose={() => {
            authDismissedRef.current.add(authKeyOf(line));
            setAuthProvider(null);
          }}
          onAuthed={() => { authDismissedRef.current.clear(); onPlay(index, line); }}
        />
      )}
    </div>
  );
}
