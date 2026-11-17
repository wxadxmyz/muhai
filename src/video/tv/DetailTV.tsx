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
  const miniVideoRef = useRef<HTMLVideoElement | null>(null);
  const [miniPlaying, setMiniPlaying] = useState(false);

  const eps = groups[line] ?? groups[0] ?? [];
  const fav = library.isFavorite(item);

  // 进入详情：焦点默认落在「立即播放」（清单 §3.6）
  useEffect(() => { focusElement(playRef.current); }, [item]);

  // V4.4.1 D1：左上角小窗「真实播放」——复用 HTML5 <video> + 现有 HLS 能力（不打包原生内核，APK 不增大）。
  // 地址来源优先级：当前集 ep.url → item.playUrl → 交给 resolvePlay 按源解析。
  // 静音 + 循环 + 自动播放；切集/切线路自动换源重播。
  // 生命周期：进入全屏播放时 TVShell 会卸载整块 DetailTV，cleanup 里 detachHls + pause，天然「进全屏停小窗、返回恢复」。
  useEffect(() => {
    const v = miniVideoRef.current;
    if (!v) return;
    let alive = true;
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
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        try { await v.play(); if (alive) setMiniPlaying(true); } catch { /* 自动播放被拦则停在封面 */ }
      } catch { /* 解析失败：保持封面底图，不影响进详情/点播放 */ }
    })();
    return () => {
      alive = false;
      try { detachHls(v); v.pause(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.sourceId, index, line]);

  // 简介浮层：焦点陷阱 + 返回键关闭
  useEffect(() => {
    if (!showDesc) return;
    return pushBackHandler(() => { setShowDesc(false); return true; });
  }, [showDesc]);

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
            <button className="tv-pill c4" data-focusable="" onClick={() => setShowDesc(true)}>
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
              <button className="tv-action-btn" data-focusable="" onClick={() => setShowDesc(false)}>
                关闭
              </button>
            </div>
            <div className="tv-sheet-body">
              <p className="tv-detail-desc" style={{ margin: 0 }}>
                {item.desc || '暂无简介信息。'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
