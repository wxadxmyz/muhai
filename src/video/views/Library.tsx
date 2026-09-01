import { useRef, useState } from 'react';
import { useLibrary } from '../../lib/library';
import { MediaItem } from '../../engine/types';
import { gradientFor, initial } from '../../lib/cover';
import { ProxiedImg } from '../../components/ProxiedImg';
import { fmtTime } from '../../lib/playerStore';

// 影视仓风格：顶部 Tab 切换「观看历史 / 影视收藏」+ 海报卡片网格
export function VideoLibrary({
  library,
  onOpen,
}: {
  library: ReturnType<typeof useLibrary>;
  onOpen: (it: MediaItem) => void;
}) {
  const [tab, setTab] = useState<'history' | 'fav'>('history');
  const pressTimer = useRef<number | undefined>(undefined);

  const historyItems = library.lib.history.filter((i) => i.mediaType === 'video');
  const favItems = library.lib.favorites.filter((i) => i.mediaType === 'video');

  const list = tab === 'history' ? historyItems : favItems;

  // 长按直接删除（触摸 + 鼠标都支持）；点封面进播放器，不显示播放/收藏图标
  const startPress = (it: MediaItem) => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      library.removeFromHistory(it);
      if (tab === 'fav') library.toggleFavorite(it);
    }, 550);
  };
  const cancelPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
  };

  return (
    <div className="view library">
      <div className="tabs">
        <button className={tab === 'history' ? 'active' : ''} onClick={(e) => { setTab('history'); (e.currentTarget.closest('.main') as HTMLElement | null)?.scrollTo({ top: 0 }); }}>
          观看历史
        </button>
        <button className={tab === 'fav' ? 'active' : ''} onClick={(e) => { setTab('fav'); (e.currentTarget.closest('.main') as HTMLElement | null)?.scrollTo({ top: 0 }); }}>
          影视收藏
        </button>
      </div>

      {list.length === 0 ? (
        <div className="empty">
          {tab === 'history' ? '还没有观看记录，去搜部剧看吧～' : '还没有收藏，详情页点 ♡ 即可收藏。'}
        </div>
      ) : (
        <div className="poster-grid">
          {list.map((it) => {
            const key = `${it.sourceId}:${it.id}`;
            // P7：进度是按「剧:集序号」存的，旧代码用不带集数的 key 去读 → 永远读到 0。
            //     这里先取续播集号，再拼出真正的存储键。
            const resumeIdx = library.lib.resumeEp[key] ?? 0;
            const prog = library.lib.watchProgress[`${key}:${resumeIdx}`] ?? 0;
            const pct = it.duration ? Math.round((prog / it.duration) * 100) : 0;
            return (
              <div className="pcard" key={key}>
                <div
                  className="pcover"
                  style={{ background: it.cover ? undefined : gradientFor(it.title) }}
                  onClick={() => onOpen(it)}
                  onTouchStart={() => startPress(it)}
                  onTouchEnd={cancelPress}
                  onTouchMove={cancelPress}
                  onMouseDown={() => startPress(it)}
                  onMouseUp={cancelPress}
                  onMouseLeave={cancelPress}
                >
                  {it.cover ? <ProxiedImg src={it.cover} alt="" /> : <span className="ph-big">{initial(it.title)}</span>}
                  {it.episodes?.length ? <span className="eps">{it.episodes.length} 集</span> : null}
                  {/* P7：影视卡片没有总时长，百分比算不出来，直接把「看到几分几秒」标出来，
                      既能确认进度确实存住了，也是排查续播最直观的信号 */}
                  {prog > 5 && <span className="eps resume-tag">看到 {fmtTime(prog)}</span>}
                  {pct > 0 && (
                    <span className="pbar">
                      <span className="pbar-in" style={{ width: pct + '%' }} />
                    </span>
                  )}
                </div>
                <div className="ptitle" onClick={() => onOpen(it)}>{it.title}</div>
                <div className="psub">
                  {it.year ?? ''} {it.sourceName ? '· ' + it.sourceName : ''}
                  {pct > 0 ? ` · 看至 ${pct}%` : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
