import { SubPage } from '../components/SubPage';
import { useSettings } from '../lib/settings';
import { Icon } from '../components/Icon';

function Row({
  icon,
  label,
  desc,
  children,
}: {
  icon: any;
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <span className="ico">
        <Icon name={icon} size={20} />
      </span>
      <span className="label">
        {label}
        {desc && <small>{desc}</small>}
      </span>
      {children}
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <div className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} />;
}

// 影流「播放」设置子页（取代旧版设置内的内联播放分组）。
export function PlayerSettingsPage({ onBack }: { onBack: () => void }) {
  const { settings, update } = useSettings();

  return (
    <SubPage title="播放" onBack={onBack}>
      <div className="settings-scroll">
        <div className="settings-card">
          <Row icon="play" label="默认播放器" desc="内置播放器已适配多数源">
            <select
              className="value-select"
              value={settings.defaultPlayer}
              onChange={(e) => update({ defaultPlayer: e.target.value as any })}
            >
              <option value="internal">内置</option>
              <option value="external">系统外部播放器</option>
            </select>
          </Row>
          <Row icon="sliders" label="硬解 / 软解" desc="优先硬解以降低功耗">
            <Switch on={settings.hardwareDecode} onChange={(v) => update({ hardwareDecode: v })} />
          </Row>
          <Row icon="repeat" label="倍速记忆" desc="记住上次播放倍速">
            <Switch on={settings.playbackRateMemory} onChange={(v) => update({ playbackRateMemory: v })} />
          </Row>
          <Row icon="plug" label="线路自动探测" desc="多线路源自动选择可用线路">
            <Switch on={settings.autoDetectLine} onChange={(v) => update({ autoDetectLine: v })} />
          </Row>
          <Row icon="fast-forward" label="自动跳过片头片尾" desc="总开关：跳过片头与片尾">
            <Switch on={settings.autoSkipIntroOutro} onChange={(v) => update({ autoSkipIntroOutro: v })} />
          </Row>
        </div>
      </div>
    </SubPage>
  );
}
