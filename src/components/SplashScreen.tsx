import { useEffect, useState } from 'react';
import { Icon } from './Icon';

// 启动页 —— 逐条对齐原型 .splash（原型 161-168 行）：
//   背景 linear-gradient(135deg,#1a1340,#3b1d6e 50%,#0f2b4d)
//   logo 96px / radius 26px / 紫青渐变底 / 白色 film 图标 52px / 紫色投影
//   名称 26px/800/letter-spacing 3px  ·  进度条 160×4   ·  跳过按钮在右上角
type Props = {
  appName: string;
  duration?: number;
};

export default function SplashScreen({ appName, duration = 1600 }: Props) {
  const [closing, setClosing] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setClosing(true), duration);
    return () => clearTimeout(t);
  }, [duration]);

  if (gone) return null;

  return (
    <div
      className={`splash${closing ? ' splash--hide' : ''}`}
      aria-hidden={closing}
      onTransitionEnd={(e) => {
        if (closing && e.propertyName === 'opacity') setGone(true);
      }}
    >
      <div className="splash-logo">
        <Icon name="film" size={52} />
      </div>
      <div className="splash-name">{appName}</div>
      <div className="splash-bar">
        <span className="splash-bar-fill" style={{ animationDuration: `${duration}ms` }} />
      </div>
      <button className="splash-skip" onClick={() => setClosing(true)}>跳过</button>
    </div>
  );
}
