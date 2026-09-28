// TV 详情/选集页（清单 §3.6）：不自动播放，OK 进入播放器。
// 上方海报 + 片名 + 信息行；操作按钮一排：立即播放 / 离线缓存 / 收藏；
// 点「内容简介」弹居中白字浮层；下方剧集网格 + 线路切换。无屏幕返回按钮，靠遥控器返回键退出。
import { useEffect, useMemo, useRef, useState } from 'react';
import { MediaItem, Episode } from '../../engine/types';
import { useLibrary } from '../../lib/library';
import { Icon } from '../../components/Icon';
import { focusElement } from '../../lib/focusNav';
import { pushBackHandler } from '../../lib/backStack';
import { tvItemPoster } from './common';

export function DetailTV({
  item,
  onPlay,
  onOffline,
  library,
}: {
  item: MediaItem;
  onPlay: (index: number, line: number) => void;
  onOffline: (it: MediaItem) => void;
  library: ReturnType<typeof useLibrary>;
}) {
  const groups = useMemo(
    () => ((item.raw?.lineGroups as any[] | undefined) ?? [item.episodes ?? []]) as Episode[][],
    [item]
  );
  const [line, setLine] = useState(0);
  const [index, setIndex] = useState(0);
  const [showDesc, setShowDesc] = useState(false);
  const playRef = useRef<HTMLButtonElement | null>(null);

  const eps = groups[line] ?? groups[0] ?? [];
  const fav = library.isFavorite(item);

  // 进入详情：焦点默认落在「立即播放」（清单 §3.6）
  useEffect(() => { focusElement(playRef.current); }, [item]);

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
      <div className="tv-detail-poster">
        {cover ? <img src={cover} alt="" /> : <div className="ph-big">{name.slice(0, 1)}</div>}
      </div>

      <div className="tv-detail-body">
        <h1 className="tv-detail-title">{name}</h1>
        <div className="tv-detail-meta">{meta}</div>

        <div className="tv-detail-actions">
          <button ref={playRef} className="tv-action-btn primary" data-focusable="" onClick={() => onPlay(index, line)}>
            <Icon name="play" size={20} /> 立即播放
          </button>
          <button className="tv-action-btn" data-focusable="" onClick={() => onOffline(item)}>
            <Icon name="download" size={20} /> 离线缓存
          </button>
          <button
            className={'tv-action-btn' + (fav ? ' active' : '')}
            data-focusable=""
            onClick={() => library.toggleFavorite(item)}
          >
            <Icon name={fav ? 'heart-filled' : 'heart'} size={20} /> 收藏
          </button>
          <button className="tv-action-btn" data-focusable="" onClick={() => setShowDesc(true)}>
            <Icon name="file-text" size={20} /> 内容简介
          </button>
        </div>

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
                <Icon name="x" size={18} /> 关闭
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
