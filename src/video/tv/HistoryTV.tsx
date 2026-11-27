// TV 历史页（清单左竖导航「历史」）：观看历史 / 影视收藏 两个标签 + 海报网格。
// V4.4.1：顶栏同一行左子标签、右删除按钮靠最右；卡片默认无 ×。
// V4.5.4 #15-#18（删除交互重做）：
//   · 去掉两段提示文字（tv-hist-tip）；
//   · 点「删除记录」进入删除模式后按钮文字不变（仍是「删除记录」），不切「完成」；
//   · 删除模式靠【返回键】退出（不再点「完成」）；光标移到卡片按 OK 即删单条；
//   · 删完最后一张卡片后，光标落到「观看历史」标签（#hist-tab-history）。
import { useEffect, useState } from 'react';
import { useLibrary } from '../../lib/library';
import { MediaItem } from '../../engine/types';
import { TVPoster, tvItemPoster } from './common';
import { toast } from '../../lib/toast';
import { pushBackHandler } from '../../lib/backStack';
import { focusElement } from '../../lib/focusNav';

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

  // V4.5.4 #17：删除模式下返回键退出删除模式（消费，不触发外层回首页）；非删除模式放行。
  // deleting 作为依赖，确保 handler 始终读到最新值。
  useEffect(
    () => pushBackHandler(() => {
      if (!deleting) return false;
      setDeleting(false);
      // V4.5.7 #1：退出删除模式后主动把光标落到第一张卡片（或删除按钮），避免停留在已消失节点
      window.setTimeout(() => {
        const c = document.getElementById('hist-card-0') || document.getElementById('hist-clear-one');
        if (c) focusElement(c);
      }, 80);
      return true;
    }),
    [deleting]
  );

  const removeOne = (it: MediaItem, idx: number) => {
    const newLen = list.length - 1; // 删后剩余数量
    if (tab === 'history') library.removeFromHistory(it);
    else library.toggleFavorite(it); // 收藏用 toggle 取消
    toast('已删除该记录');
    // V4.5.7 #1：删中间卡片后光标不得丢失。
    //  - 删完还有卡片：聚焦顶上来的同位置卡片（idx 超出则最后一张），保证光标连续；
    //  - 删光了：回「观看历史」标签。
    if (newLen <= 0) {
      window.setTimeout(() => {
        const t = document.getElementById('hist-tab-history');
        if (t) focusElement(t);
      }, 80);
      setDeleting(false);
    } else {
      const target = Math.min(idx, newLen - 1);
      window.setTimeout(() => {
        const el = document.getElementById(`hist-card-${target}`);
        if (el) focusElement(el);
      }, 80);
    }
  };
  const clearAll = () => {
    if (tab === 'history') library.clearHistory();
    else library.lib.favorites.slice().forEach((it) => library.toggleFavorite(it));
    setDeleting(false);
    toast('已清空全部记录');
    window.setTimeout(() => {
      const t = document.getElementById('hist-tab-history');
      if (t) focusElement(t);
    }, 80);
  };

  const switchTab = (t: 'history' | 'fav') => {
    setTab(t);
    setDeleting(false);
  };

  return (
    // V4.5.7 #18：负 margin 抵消 .tv-main 顶部内边距，与搜索页顶部间距一致
    <div className="tv-scroll tv-flush-top" data-scroll>
      <div className="tv-history-bar" id="hist-bar">
        <div className="tv-history-tabs">
          <div
            id="hist-tab-history"
            className={'tv-cat' + (tab === 'history' ? ' active' : '')}
            data-focusable="" data-nav-right="#hist-tab-fav" data-nav-down="#hist-card-0"
            onClick={() => switchTab('history')} role="button">观看历史</div>
          <div
            id="hist-tab-fav"
            className={'tv-cat' + (tab === 'fav' ? ' active' : '')}
            data-focusable="" data-nav-left="#hist-tab-history" data-nav-right="#hist-clear-one"
            onClick={() => switchTab('fav')} role="button">影视收藏</div>
          {/* V4.5.4 #15：删除交互两段提示文字已去掉 */}
        </div>
        {list.length > 0 && (
          <div className="tv-history-actions">
            <div
              id="hist-clear-one"
              className={'tv-hist-clear' + (deleting ? ' primary' : ' danger')}
              data-focusable="" data-nav-left="#hist-tab-fav" data-nav-right="#hist-clear-all" data-nav-down="#hist-card-0"
              onClick={() => setDeleting((m) => !m)} role="button">删除记录</div>
            <div
              id="hist-clear-all"
              className="tv-hist-clear danger" data-focusable=""
              data-nav-left="#hist-clear-one" data-nav-down="#hist-card-0"
              onClick={clearAll} role="button">一键清空</div>
          </div>
        )}
      </div>
      {list.length === 0 ? (
        <div className="tv-empty">{tab === 'history' ? '还没有观看记录，去搜部剧看吧～' : '还没有收藏，详情页点 ♡ 即可收藏。'}</div>
      ) : (
        <div className={'tv-history-grid' + (deleting ? ' deleting' : '')}>
          {list.map((it, idx) => {
            const { cover, name } = tvItemPoster(it);
            return (
              <div key={`${it.sourceId}:${it.id}`} className="tv-hist-cell">
                <TVPoster
                  name={name}
                  cover={cover}
                  year={it.year}
                  domId={`hist-card-${idx}`}
                  navUp={tab === 'fav' ? '#hist-tab-fav' : '#hist-tab-history'}
                  onClick={() => { if (deleting) { removeOne(it, idx); } else onOpenDetail(it); }}
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
