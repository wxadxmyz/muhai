// TV 历史页（清单左竖导航「历史」）：观看历史 / 影视收藏 两个标签 + 海报网格。
// V4.3.9：新增「管理」模式——进入后每条卡片带 × 可删单条，另有「清空」按钮删全部（带确认）。
// 卡片点击 → 进详情页（管理模式下点击 × 才删，点卡片仍进详情）。
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
  const [manage, setManage] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const list = (tab === 'history' ? library.lib.history : library.lib.favorites).filter((i) => i.mediaType === 'video');

  const removeOne = (it: MediaItem) => {
    if (tab === 'history') library.removeFromHistory(it);
    else library.toggleFavorite(it); // 收藏用 toggle 取消
  };
  const clearAll = () => {
    if (tab === 'history') library.clearHistory();
    else library.lib.favorites.slice().forEach((it) => library.toggleFavorite(it));
    setConfirmClear(false);
    setManage(false);
  };

  return (
    <div className="tv-scroll" data-scroll>
      <div className="tv-history-bar">
        <div className="tv-history-tabs">
          <div className={'tv-cat' + (tab === 'history' ? ' active' : '')} data-focusable="" onClick={() => { setTab('history'); setManage(false); }} role="button">观看历史</div>
          <div className={'tv-cat' + (tab === 'fav' ? ' active' : '')} data-focusable="" onClick={() => { setTab('fav'); setManage(false); }} role="button">影视收藏</div>
        </div>
        {list.length > 0 && (
          <div className="tv-history-actions">
            <div className="tv-hist-clear" data-focusable="" onClick={() => setManage((m) => !m)} role="button">{manage ? '完成' : '管理'}</div>
            {manage && (
              <div className="tv-hist-clear danger" data-focusable="" onClick={() => setConfirmClear(true)} role="button">清空</div>
            )}
          </div>
        )}
      </div>
      {list.length === 0 ? (
        <div className="tv-empty">{tab === 'history' ? '还没有观看记录，去搜部剧看吧～' : '还没有收藏，详情页点 ♡ 即可收藏。'}</div>
      ) : (
        <div className="tv-history-grid">
          {list.map((it) => {
            const { cover, name } = tvItemPoster(it);
            return (
              <div key={`${it.sourceId}:${it.id}`} className="tv-hist-cell">
                <TVPoster name={name} cover={cover} year={it.year} onClick={() => { if (!manage) onOpenDetail(it); }} focusable={!manage} />
                {manage && (
                  <div className="tv-hist-del" data-focusable="" onClick={() => removeOne(it)} role="button">×</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {confirmClear && (
        <div className="tv-overlay" data-focus-root>
          <div className="tv-sheet" style={{ padding: 28, maxWidth: 520 }}>
            <h3 style={{ marginTop: 0 }}>确认清空{tab === 'history' ? '观看历史' : '影视收藏'}？</h3>
            <p style={{ color: 'var(--muted)' }}>此操作不可恢复，共 {list.length} 条记录。</p>
            <div style={{ display: 'flex', gap: 14, marginTop: 24 }}>
              <button className="tv-action-btn" data-focusable="" data-autofocus="" onClick={() => setConfirmClear(false)}>取消</button>
              <button className="tv-action-btn danger" data-focusable="" onClick={clearAll}>确认清空</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
