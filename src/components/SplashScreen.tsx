import { useEffect, useState } from 'react';

type Props = {
  appName: string;
  iconSrc: string;
  gradient: string;
  duration?: number;
};

export default function SplashScreen({ appName, iconSrc, gradient, duration = 1600 }: Props) {
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
      style={{ background: gradient }}
      aria-hidden={closing}
      onTransitionEnd={(e) => {
        if (closing && e.propertyName === 'opacity') setGone(true);
      }}
    >
      <div className="splash-logo">
        <img src={iconSrc} alt="" className="splash-icon" />
      </div>
      <div className="splash-name">{appName}</div>
      <div className="splash-bar">
        <span className="splash-bar-fill" style={{ animationDuration: `${duration}ms` }} />
      </div>
      <button className="splash-skip" onClick={() => setClosing(true)}>跳过</button>
    </div>
  );
}
