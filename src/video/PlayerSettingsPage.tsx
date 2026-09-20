import { SubPage } from '../components/SubPage';
import { useSettings } from '../lib/settings';

/** 单行：左「标题 + 说明」、右控件。版式对齐原型 .set-line（无行图标、下划线分隔）。 */
function Line({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="set-line">
      <div>
        <div className="lbl">{label}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

/** 胶囊分段控件（对齐原型 .pill-sel）。 */
function PillSel<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="pill-sel" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <div className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} />;
}

// 幕海「播放设置」子页（版式对齐原型 player-settings：无卡片、无行图标、胶囊分段）。
export function PlayerSettingsPage({ onBack }: { onBack: () => void }) {
  const { settings, update } = useSettings();

  return (
    <SubPage title="播放设置" onBack={onBack}>
      <div className="set-list">
        <Line label="默认播放器" desc="内置播放器已适配多数源">
          <PillSel
            value={settings.defaultPlayer}
            onChange={(v) => update({ defaultPlayer: v })}
            options={[
              { value: 'internal', label: '内置' },
              { value: 'external', label: '系统' },
            ]}
          />
        </Line>
        <Line label="硬解 / 软解">
          <Switch on={settings.hardwareDecode} onChange={(v) => update({ hardwareDecode: v })} />
        </Line>
        <Line label="倍速记忆">
          <Switch on={settings.playbackRateMemory} onChange={(v) => update({ playbackRateMemory: v })} />
        </Line>
        <Line label="线路自动探测">
          <Switch on={settings.autoDetectLine} onChange={(v) => update({ autoDetectLine: v })} />
        </Line>
        <Line label="画面缩放">
          <PillSel
            value={settings.videoScale}
            onChange={(v) => update({ videoScale: v })}
            options={[
              { value: 'contain', label: '适应' },
              { value: 'cover', label: '铺满' },
              { value: 'stretch', label: '拉伸' },
            ]}
          />
        </Line>
        <Line label="画中画 / 后台播放">
          <Switch on={settings.pipEnabled} onChange={(v) => update({ pipEnabled: v })} />
        </Line>
      </div>
    </SubPage>
  );
}
