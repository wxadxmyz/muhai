// mock 适配器：内置离线演示数据，保证原型开箱即用（无需任何外部依赖即可看 UI）
import { MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';

const SAMPLE_MP3 = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
const M3U8_LINES = [
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://test-streams.mux.dev/pts_shift/master.m3u8',
  'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
];

const MUSIC: MediaItem[] = [
  { id: 'm1', sourceId: '', sourceName: '', title: '夜空中最亮的星', artist: '逃跑计划', album: '世界', mediaType: 'music', playUrl: SAMPLE_MP3, duration: 252, cover: '', raw: { lyric: ['夜空中最亮的星', '能否听清', '那仰望的人', '心底的孤独和叹息'] } },
  { id: 'm2', sourceId: '', sourceName: '', title: '平凡之路', artist: '朴树', album: '猎户星座', mediaType: 'music', playUrl: SAMPLE_MP3, duration: 301, cover: '', raw: { lyric: ['徘徊着的 在路上的', '你要走吗', 'via 易碎的 骄傲着', '那也曾是我的模样'] } },
  { id: 'm3', sourceId: '', sourceName: '', title: '稻香', artist: '周杰伦', album: '魔杰座', mediaType: 'music', playUrl: SAMPLE_MP3, duration: 223, cover: '' },
  { id: 'm4', sourceId: '', sourceName: '', title: '晴天', artist: '周杰伦', album: '叶惠美', mediaType: 'music', playUrl: SAMPLE_MP3, duration: 269, cover: '' },
  { id: 'm5', sourceId: '', sourceName: '', title: '起风了', artist: '买辣椒也用券', album: '起风了', mediaType: 'music', playUrl: SAMPLE_MP3, duration: 325, cover: '' },
  { id: 'm6', sourceId: '', sourceName: '', title: '海阔天空', artist: 'Beyond', album: '乐与怒', mediaType: 'music', playUrl: SAMPLE_MP3, duration: 326, cover: '' },
  { id: 'm7', sourceId: '', sourceName: '', title: '光年之外', artist: '邓紫棋', album: '光年之外', mediaType: 'music', playUrl: SAMPLE_MP3, duration: 235, cover: '' },
  { id: 'm8', sourceId: '', sourceName: '', title: '夜的第七章', artist: '周杰伦', album: '依然范特西', mediaType: 'music', playUrl: SAMPLE_MP3, duration: 273, cover: '' },
  { id: 'm9', sourceId: '', sourceName: '', title: '泡沫', artist: '邓紫棋', album: 'Xposed', mediaType: 'music', playUrl: SAMPLE_MP3, duration: 257, cover: '' },
  { id: 'm10', sourceId: '', sourceName: '', title: '成都', artist: '赵雷', album: '无法长大', mediaType: 'music', playUrl: SAMPLE_MP3, duration: 328, cover: '' },
];

function ep(name: string) {
  return { name, url: M3U8_LINES[0] };
}

const VIDEO: MediaItem[] = [
  {
    id: 'v1', sourceId: '', sourceName: '', title: '星际穿越', year: '2014', genre: '科幻', mediaType: 'video',
    cover: '', playUrl: M3U8_LINES[0], episodes: [ep('正片')], duration: 169,
    raw: { desc: '近未来，地球环境急剧恶化。前 NASA 飞行员库珀穿越虫洞，为人类寻找新家园。', lines: 2 },
  },
  {
    id: 'v2', sourceId: '', sourceName: '', title: '繁花 第一季', year: '2023', genre: '剧情', mediaType: 'video',
    cover: '', playUrl: M3U8_LINES[0], episodes: [ep('第1集'), ep('第2集'), ep('第3集'), ep('第4集')], duration: 45,
    raw: { desc: '黄河路上一场场商战与情爱，沪上风云尽在繁花。', lines: 2 },
  },
  {
    id: 'v3', sourceId: '', sourceName: '', title: '鬼灭之刃', year: '2019', genre: '动漫', mediaType: 'video',
    cover: '', playUrl: M3U8_LINES[0], episodes: [ep('第1集'), ep('第2集'), ep('第3集')], duration: 24,
    raw: { desc: '家人被鬼杀害的少年灶门炭治郎，为救妹妹踏上斩鬼之路。', lines: 3 },
  },
  {
    id: 'v4', sourceId: '', sourceName: '', title: '欢乐现场', year: '2022', genre: '综艺', mediaType: 'video',
    cover: '', playUrl: M3U8_LINES[0], episodes: [ep('第1期'), ep('第2期')], duration: 90,
    raw: { desc: '明星竞演真人秀，舞台与笑声齐飞。', lines: 1 },
  },
  {
    id: 'v5', sourceId: '', sourceName: '', title: '盗梦空间', year: '2010', genre: '科幻', mediaType: 'video',
    cover: '', playUrl: M3U8_LINES[0], episodes: [ep('正片')], duration: 148,
    raw: { desc: '造梦师柯布潜入他人潜意识，执行一场前所未有的盗梦任务。', lines: 2 },
  },
  {
    id: 'v6', sourceId: '', sourceName: '', title: '三体', year: '2023', genre: '科幻', mediaType: 'video',
    cover: '', playUrl: M3U8_LINES[0], episodes: [ep('第1集'), ep('第2集'), ep('第3集')], duration: 50,
    raw: { desc: '应对外星文明「三体」的降临，人类命运走向未知。', lines: 2 },
  },
  {
    id: 'v7', sourceId: '', sourceName: '', title: '甄嬛传', year: '2011', genre: '古装', mediaType: 'video',
    cover: '', playUrl: M3U8_LINES[0], episodes: [ep('第1集'), ep('第2集'), ep('第3集'), ep('第4集'), ep('第5集')], duration: 45,
    raw: { desc: '后宫女子甄嬛从入宫到掌权的跌宕一生。', lines: 2 },
  },
  {
    id: 'v8', sourceId: '', sourceName: '', title: '千与千寻', year: '2001', genre: '动画', mediaType: 'video',
    cover: '', playUrl: M3U8_LINES[0], episodes: [ep('正片')], duration: 125,
    raw: { desc: '少女千寻误入神灵世界，为救父母展开奇异冒险。', lines: 1 },
  },
];

// 为演示源补上多线路（lineGroups），让「线路切换」在离线演示下也真实可用
const VIDEO_FINAL: MediaItem[] = VIDEO.map((it) => {
  const lines = (it.raw?.lines as number) || 1;
  const baseEps = it.episodes ?? [{ name: '正片', url: M3U8_LINES[0] }];
  const lineGroups = Array.from({ length: lines }, (_, li) =>
    baseEps.map((e) => ({ name: e.name, url: M3U8_LINES[li % M3U8_LINES.length] }))
  );
  return { ...it, episodes: lineGroups[0], raw: { ...it.raw, lineGroups, lines } };
});

export function createMockSource(cfg: SourceConfig): MediaSource {
  const tag = (it: MediaItem): MediaItem => ({ ...it, sourceId: cfg.id, sourceName: cfg.name });

  return {
    async search(keyword: string): Promise<MediaItem[]> {
      const kw = keyword.trim().toLowerCase();
      const all = [...MUSIC, ...VIDEO_FINAL].map(tag);
      if (!kw) return all;
      return all.filter(
        (it) =>
          it.title.toLowerCase().includes(kw) ||
          (it.artist ?? '').toLowerCase().includes(kw) ||
          (it.genre ?? '').toLowerCase().includes(kw)
      );
    },

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      const it = [...MUSIC, ...VIDEO_FINAL].find((x) => x.id === itemId);
      return { url: it?.playUrl ?? M3U8_LINES[0] };
    },

    async test(): Promise<boolean> {
      return true;
    },
  };
}
