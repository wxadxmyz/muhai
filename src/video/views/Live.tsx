import { SourceConfig } from '../../engine/types';
import { Icon } from '../../components/Icon';

export function Live({ sources, onOpenSources }: { sources: SourceConfig[]; onOpenSources: () => void }) {
  // 直播线路来自音源 JSON 中含直播(m3u8/直播源)的条目。当前未检测到可用直播源时给出引导。
  return (
    <div className="view live">
      <div className="search-bar big">
        <span className="search-ico"><Icon name="cast" size={18} /></span>
        <input placeholder="搜索直播频道 / 赛事 / 电视台…" readOnly />
      </div>

      <div className="blank-state">
        <div className="blank-art"><Icon name="cast" size={44} /></div>
        <h2>直播源未配置</h2>
        <p className="muted">
          直播线路来自你导入的音源 JSON 中含直播(m3u8/直播源)的条目。<br />
          在「设置 → 源管理」导入含直播线路的源后，这里即可观看。
        </p>
        <button className="primary" onClick={onOpenSources}>去源管理添加</button>
      </div>
    </div>
  );
}
