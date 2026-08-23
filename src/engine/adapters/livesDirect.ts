// 纯直连直播源：内置 lives[]，不依赖任何 spider/jar/网络。
// 用于在用户没有任何可用影视源时，依然能立刻看直播（mux.dev 公开测试流）。
import { LiveChannelSource, MediaSource } from '../types';

// 内置直播频道：仅 mux.dev 公开测试流（保证 100% 可达）
// 其他公开 CCTV 流（ivi.bupt.edu.cn 等）经常被墙/限速，此处不写死以避免误导
const BUILTIN_LIVES: LiveChannelSource[] = [
  { name: '公开测试线路（720p）', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: '公开测试·多语轨 PTS', url: 'https://test-streams.mux.dev/pts_shift/master.m3u8' },
  { name: '公开测试·Unified Streaming', url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8' },
];

export function createLivesDirectSource(): MediaSource {
  return {
    name: '幕海·内置直连直播',
    test: async () => BUILTIN_LIVES.length > 0,
    home: async () => [],
    lives: async () => BUILTIN_LIVES,
  };
}