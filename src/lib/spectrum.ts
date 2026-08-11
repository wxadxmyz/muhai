// 频谱单例：一个 <audio> 元素一生只能创建一个 MediaElementSource，
// 因此把 AnalyserNode 缓存起来，全屏播放页反复开关不会报错。
let cachedAudio: HTMLAudioElement | null = null;
let cachedAnalyser: AnalyserNode | null = null;

export function getAnalyser(audio: HTMLAudioElement): AnalyserNode | null {
  const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return null;
  if (cachedAnalyser && cachedAudio === audio) return cachedAnalyser;
  try {
    const ctx: AudioContext = new Ctx();
    const src = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    cachedAudio = audio;
    cachedAnalyser = analyser;
    return analyser;
  } catch {
    return null;
  }
}
