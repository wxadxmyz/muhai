// TV 历史页（清单左竖导航「历史」）：观看历史 / 影视收藏 两个标签 + 海报网格。
// V4.4.1：按 UI 定稿重写删除交互——
//   · 顶栏同一行：左「观看历史 / 影视收藏」子标签，右「删除记录 / 一键清空」按钮靠最右；
//   · 卡片默认无 ×；点「删除记录」进入删除模式（按钮变「完成」、卡片红框提示），
//     光标移到卡片上按 OK（点击）即删单条、不弹确认窗；点「完成」退出删除（不删）；
//   · 「一键清空」直接清空，不弹确认窗；正常模式点卡片 → 进详情页。
import { useState } from 'react';
import { useLibrary } from '../../lib/library';
import { MediaItem } from '../../engine/types';
import { TVPoster, tvItemPoster } from './common';
import { toast } from '../../lib/toast';

export function HistoryTV({
  library,
  onOpenDetail,
}: {
  library: ReturnType<typeof useLibrary>;
  onOpenDetail: (it: MediaItem) => void;
}) {
  const [tab, setTab] = useState<'history' | 'fav'>('history');
  const [deleting, setDeleting] = useState(false);
  const list = (tab === 'history' ? library.lib.history : library.lib.favorites).filter((i) => i.mediaType === 'video');

  const removeOne = (it: MediaItem) => {
    if (tab === 'history') library.removeFromHistory(it);
    else library.toggleFavorite(it); // 收藏用 toggle 取消
  };
  const clearAll = () => {
    if (tab === 'history') library.clearHistory();
    else library.lib.favorites.slice().forEach((it) => library.toggleFavorite(it));
    setDeleting(false);
    toast('已清空全部记录');
  };

  const switchTab = (t: 'history' | 'fav') => {
    setTab(t);
    setDeleting(false);
  };

  return (
    <div className="tv-scroll" data-scroll>
      <div className="tv-history-bar">
        <div className="tv-history-tabs">
          <div className={'tv-cat' + (tab === 'history' ? ' active' : '')} data-focusable="" onClick={() => switchTab('history')} role="button">观看历史</div>
          <div className={'tv-cat' + (tab === 'fav' ? ' active' : '')} data-focusable="" onClick={() => switchTab('fav')} role="button">影视收藏</div>
          <span className="tv-hist-tip">{deleting ? '光标移到卡片上按 OK 即删除，点「完成」退出' : '点「删除记录」后可删除单条'}</span>
        </div>
        {list.length > 0 && (
          <div className="tv-history-actions">
            <div className={'tv-hist-clear' + (deleting ? ' primary' : ' danger')} data-focusable="" onClick={() => setDeleting((m) => !m)} role="button">{deleting ? '完成' : '删除记录'}</div>
            <div className="tv-hist-clear danger" data-focusable="" onClick={clearAll} role="button">一键清空</div>
          </div>
        )}
      </div>
      {list.length === 0 ? (
        <div className="tv-empty">{tab === 'history' ? '还没有观看记录，去搜部剧看吧～' : '还没有收藏，详情页点 ♡ 即可收藏。'}</div>
      ) : (
        <div className={'tv-history-grid' + (deleting ? ' deleting' : '')}>
          {list.map((it) => {
            const { cover, name } = tvItemPoster(it);
            return (
              <div key={`${it.sourceId}:${it.id}`} className="tv-hist-cell">
                <TVPoster
                  name={name}
                  cover={cover}
                  year={it.year}
                  onClick={() => { if (deleting) { removeOne(it); toast('已删除该记录'); } else onOpenDetail(it); }}
                  focusable
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
