// TV 组件共享：海报卡 + 工具。
import { MediaItem } from '../../engine/types';
import { ProxiedImg } from '../../components/ProxiedImg';
import { tryCoverFallback } from '../../lib/crossCover';
import { useSources } from '../../store';

const TYPE_LABEL: Record<string, string> = { tv: '剧', movie: '影', variety: '综', anime: '漫' };

export function TVPoster({
  name,
  cover,
  type,
  year,
  rating,
  onClick,
  focusable = true,
}: {
  name: string;
  cover?: string;
  type?: string;
  year?: string;
  rating?: number;
  onClick?: () => void;
  focusable?: boolean;
}) {
  const { sources } = useSources('video');
  const show = cover || '';
  return (
    <div
      className="tv-poster"
      data-focusable={focusable ? '' : undefined}
      onClick={onClick}
      role="button"
      title={name}
    >
      {show ? (
        <ProxiedImg
          src={show}
          alt=""
          fallbackText={name}
          onFinalFail={() =>
            tryCoverFallback({
              key: name,
              title: name,
              allSources: sources,
              onResolved: () => {},
            })
          }
        />
      ) : (
        <div className="ph-big">{name.slice(0, 1)}</div>
      )}
      {type ? <span className="tv-tag">{TYPE_LABEL[type] ?? type}</span> : null}
      {rating ? <span className="tv-score">★ {rating}</span> : null}
      <div className="tv-pname">{name}</div>
    </div>
  );
}

export function tvItemPoster(it: MediaItem): { cover?: string; name: string } {
  const raw: any = it.raw ?? {};
  const cover =
    it.cover ||
    raw.vod_pic ||
    raw.pic ||
    raw.poster ||
    raw.thumb ||
    raw.cover ||
    raw.pic_thumb ||
    raw.vod_pic_thumb ||
    '';
  return { cover, name: it.title || '未命名' };
}
