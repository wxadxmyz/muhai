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

export function DetailTV({
  item,
  onPlay,
  onOffline,
  library,
  sources,
}: {
  item: MediaItem;
  onPlay: (index: number, line: number) => void;
  onOffline: (it: MediaItem) => void;
  library: ReturnType<typeof useLibrary>;
  sources: SourceConfig[];
}) {
  const groups = useMemo(
    () => ((item.raw?.lineGroups as any[] | undefined) ?? [item.episodes ?? []]) as Episode[][],
    [item]
  );
  const [line, setLine] = useState(0);
  const [index, setIndex] = useState(0);
  const [showDesc, setShowDesc] = useState(false);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const descBtnRef = useRef<HTMLButtonElement | null>(null); // V4.4.3 #4：关闭简介后光标归位到「内容简介」按钮
  const descBodyRef = useRef<HTMLDivElement | null>(null); // V4.4.3 #3：简介正文滚动容器
  const miniVideoRef = useRef<HTMLVideoElement | null>(null);
  const [miniPlaying, setMiniPlaying] = useState(false);

  const eps = groups[line] ?? groups[0] ?? [];
  const fav = library.isFavorite(item);

  // 进入详情：焦点默认落在「立即播放」（清单 §3.6）
  useEffect(() => { focusElement(playRef.current); }, [item]);

  // V4.4.2 #12/#17：左上角小窗「真实播放」+ 无缝续播。
  //  - 带声音：先静音保证自动播放成功，play() 成功后立即取消静音（TV WebView 通常允许有声播放）。
  //  - 无缝续播：起播后从 library.watchProgress[resumeKey] 读进度 seek 过去；播放中节流写回，
  //    这样进全屏（VideoPlayer 读同一 resumeKey）与返回详情（小窗读同一 resumeKey）进度完全衔接。
  //  - 复用 HTML5 <video> + 现有 HLS 能力（不打包原生内核，APK 不增大）。
  const resumeKey = `${item.sourceId}:${item.id}:${index}`;
  useEffect(() => {
    const v = miniVideoRef.current;
    if (!v) return;
    let alive = true;
    let timeUpdateHandler: (() => void) | null = null;
    let lastSave = 0;
    setMiniPlaying(false);
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
          const saved = library.lib.watchProgress[resumeKey] ?? 0;
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
          if (alive) setMiniPlaying(true);
          // V4.4.2 #12：起播成功后取消静音，小窗带声音
          try { v.muted = false; } catch { /* ignore */ }
        } catch { /* 自动播放被拦则停在封面 */ }
        // V4.4.2 #17：播放中节流写回进度（5 秒一次），供进全屏/返回时无缝衔接
        timeUpdateHandler = () => {
          const now = Date.now();
          if (!alive || now - lastSave < 5000) return;
          const t = v.currentTime;
          if (!(t > 0) || !isFinite(t)) return;
          lastSave = now;
          library.setProgressBoth(resumeKey, t, `${item.sourceId}:${item.id}`, index);
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
          library.setProgressBoth(resumeKey, v.currentTime, `${item.sourceId}:${item.id}`, index);
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

  const meta = [
    item.year ? <b key="y">{item.year}</b> : null,
    (item.raw as any)?.area ? <span key="a">{(item.raw as any).area}</span> : null,
    (item.raw as any)?.type ? <span key="t">{(item.raw as any).type}</span> : null,
    item.score ? <b key="r">★ {item.score}</b> : null,
    eps.length ? <span key="e">{eps.length} 集</span> : null,
  ].filter(Boolean);

  const { cover, name } = tvItemPoster(item);

  return (
    <div className="tv-detail" data-scroll>
      {/* V4.4.1：上排 = 播放小窗 + 片名/信息/胶囊；下排 = 线路 + 选集（按 UI 定稿移到播放窗与简介下方） */}
      <div className="dt-top">
        {/* 播放小窗口（封面做底 + 中央播放按钮，点整窗即播） */}
        <div
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
          <div className="dshade" />
          <div className="dplay"><Icon name="play" size={38} /></div>
          <div className="dlabel">{name} · 立即播放</div>
        </div>

        <div className="tv-detail-body">
          <h1 className="tv-detail-title">{name}</h1>
          <div className="tv-detail-meta">{meta}</div>
          <p className={'tv-detail-desc' + (item.desc ? '' : ' empty')}>{item.desc || '暂无剧情简介。'}</p>
          {/* 胶囊按钮：播放 → 离线缓存 → 收藏 → 内容简介（真实软件四色胶囊） */}
          <div className="tv-pillrow">
            <button ref={playRef} className="tv-pill c1" data-focusable="" onClick={() => onPlay(index, line)}>
              <Icon name="play" size={20} /> 立即播放
            </button>
            <button className="tv-pill c2" data-focusable="" onClick={() => onOffline(item)}>
              <Icon name="download" size={20} /> 离线缓存
            </button>
            <button className={'tv-pill c3' + (fav ? ' active' : '')} data-focusable="" onClick={() => library.toggleFavorite(item)}>
              <Icon name={fav ? 'heart-filled' : 'heart'} size={20} /> {fav ? '已收藏' : '收藏'}
            </button>
            <button ref={descBtnRef} className="tv-pill c4" data-focusable="" onClick={() => setShowDesc(true)}>
              <Icon name="file-text" size={20} /> 内容简介
            </button>
          </div>
        </div>
      </div>

      {/* 下排：线路 + 选集，位于播放窗与简介下方 */}
      <div className="dt-bottom">
        {groups.length > 1 && (
          <div className="tv-line-row">
            <span className="lbl">线路</span>
            {groups.map((g, i) => (
              <span
                key={i}
                className={'tv-line-pill' + (line === i ? ' active' : '')}
                data-focusable=""
                onClick={() => { setLine(i); setIndex(0); }}
                role="button"
              >
                线路{i + 1}
                {g.length ? `（${g.length}）` : ''}
              </span>
            ))}
          </div>
        )}

        <div className="tv-row-title">选集</div>
        <div className="tv-ep-grid">
          {eps.length === 0 ? (
            <div className="tv-empty">暂无选集</div>
          ) : (
            eps.map((ep, i) => (
              <div
                key={i}
                className={'tv-ep' + (index === i ? ' active' : '')}
                data-focusable=""
                onClick={() => { setIndex(i); onPlay(i, line); }}
                role="button"
              >
                {ep.name || `第${i + 1}集`}
              </div>
            ))
          )}
        </div>
      </div>

      {showDesc && (
        <div className="tv-overlay" data-focus-root>
          <div className="tv-sheet" style={{ width: 'min(680px, 90vw)' }}>
            <div className="tv-sheet-head">
              <h3>{name} · 简介</h3>
              <button className="tv-action-btn" data-focusable="" onClick={closeDesc}>
                关闭
              </button>
            </div>
            {/* V4.4.3 #3：正文可聚焦 + ↑↓ 上下滚动，长简介也能看全；提示文字告诉用户可按上下键 */}
            <div
              ref={descBodyRef}
              className="tv-sheet-body"
              data-focusable=""
              tabIndex={0}
              onKeyDown={onDescKey}
            >
              <p className="tv-detail-desc" style={{ margin: 0, display: 'block', WebkitLineClamp: 'unset' }}>
                {item.desc || '暂无简介信息。'}
              </p>
              <div style={{ marginTop: 16, fontSize: 15, color: 'var(--muted)' }}>按遥控器 ↑ / ↓ 键上下滚动查看完整简介</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
