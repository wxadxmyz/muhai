// TV 历史页（清单左竖导航「历史」）：观看历史 / 影视收藏 两个标签 + 海报网格。
// 卡片点击 → 进详情页（与首页/搜索结果一致的 OK→详情路径）。无长按删除（遥控器无长按），
// 仅展示；删除保留在手机端逻辑。
import { useState } from 'react';
import { useLibrary } from '../../lib/library';
import { MediaItem } from '../../engine/types';
import { TVPoster, tvItemPoster } from './common';

export function HistoryTV({
  library,
  onOpenDetail,
}: {
  library: ReturnType<typeof useLibrary>;
  onOpenDetail: (it: MediaItem) => void;
}) {
  const [tab, setTab] = useState<'history' | 'fav'>('history');
  const list = (tab === 'history' ? library.lib.history : library.lib.favorites).filter((i) => i.mediaType === 'video');

  return (
    <div className="tv-scroll" data-scroll>
      <div className="tv-history-tabs">
        <div className={'tv-cat' + (tab === 'history' ? ' active' : '')} data-focusable="" onClick={() => setTab('history')} role="button">观看历史</div>
        <div className={'tv-cat' + (tab === 'fav' ? ' active' : '')} data-focusable="" onClick={() => setTab('fav')} role="button">影视收藏</div>
      </div>
      {list.length === 0 ? (
        <div className="tv-empty">{tab === 'history' ? '还没有观看记录，去搜部剧看吧～' : '还没有收藏，详情页点 ♡ 即可收藏。'}</div>
      ) : (
        <div className="tv-history-grid">
          {list.map((it) => {
            const { cover, name } = tvItemPoster(it);
            return <TVPoster key={`${it.sourceId}:${it.id}`} name={name} cover={cover} year={it.year} onClick={() => onOpenDetail(it)} />;
          })}
        </div>
      )}
    </div>
  );
}
