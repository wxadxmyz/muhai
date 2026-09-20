# 幕海 MuHai 更新日志（CHANGELOG）

> 代码内只保留「为什么这么做」的注释；版本迭代的权威记录统一收敛到此文件，不再在源码里满屏写 `V3.x.x` 行内标记。
> 版本号同时维护在 `package.json` 与 `src-tauri/tauri.conf.json`。

---

## V3.6.0

本版接入 **drpy3 / drpy2 蜘蛛源引擎（P0）**——影视仓（TVBox）生态里最有价值的一批源是「JS 规则源」，
此前幕海的裸 QuickJS 沙箱跑不了它们，V3.6.0 起可以。

### 新增
- **drpy3 引擎**：把 drpy3 引擎 + peer 链 + 库包 + cheerio 版 jsoup 四件套 + 幕海胶水打成一个自包含
  bundle（`src-tauri/vendor/drpy3-muhai.bundle.js`，1.7MB，esbuild IIFE），在 QuickJS 里 eval 一次常驻。
  drpy3 自带 `load2x` 兼容层，**drpy2 老源（`var rule = {...}`）零改动直接跑**，一条路吃两家。
- **宿主补齐**：QuickJS 原生没有 `URL / TextEncoder / TextDecoder / atob / WebAssembly / crypto / ArrayBuffer.prototype.resizable`，
  库包与 cheerio 在模块初始化期就会用到。分两层垫片补齐（`quickjs-pre.js` 零依赖先跑，`quickjs-shims.js` 再装 whatwg-url 的 URL）。
- **同步 HTTP 桥 `__mhHttp`**：按 drpy3 宿主对接指南 §2.1 的 req 契约实现（headers/method/timeout/body/data/redirect/buffer/encoding），
  文本响应按响应头 charset 解码（gbk 站点也能正确出字），`buffer:1/2` 走 base64 字节通道。
- **Promise 手动泵**：QuickJS 同步宿主没有事件循环，引擎内部大量 `await`。Rust 侧 `execute_pending_job()` 循环推进
  job 队列直到 Promise settle，等效宿主对接指南的「档 C」。
- **专用引擎线程**：QuickJS 单线程亲和，引擎固定在一条 16MB 栈的 OS 线程上常驻，调用经 mpsc 投递，避免跨线程复用 Runtime。
- **前端适配 `src/engine/adapters/drpy3.ts`**：识别 drpy 规则（`lang:'dr2'/'dr3'`、`var rule =`、`defineSource(`、`export default {meta,rule}`），
  自动转派到 drpy3 引擎；TVBox 六环节结果映射回幕海 `MediaItem`（home 取前 2 个分类各一页、detail 拆选集并记住线路 flag、play 走 `play(flag,url,[])`）。
  源配置里 `extra.engine = 'drpy3' | 'legacy'` 可强制指定走哪条路。

### 验证
- Node 侧：`drpy3 原生源`（百忙无果 dr3）与 `drpy2 老源`（百忙无果[官] dr2）六环节全通（home/category/detail/play 返回真实数据）。
- Rust 侧（reqwest 真网）：init 214ms（含 bundle 冷启动）→ home 2ms → category 430ms → detail → play 全通。
  search 返回空是 mgtv 搜索接口对沙箱出口 403（源注释里也写了「新版接口加了验证」），非引擎问题。

## V3.5.8

本版处理 2026-09-20 反馈的 5 处 UI 问题，并完成点播源仓库瘦身。

### 源仓库（Gitee `xmyzjxn/muhai-vod`）
- **移除 6 个无搜索能力的子站（22 → 16）**：以「`ac=detail&wd=<关键词>` 能否返回影片」为标准重新实测。
  - 茅台资源：接口返回 `code:1002 Current API forbids keyword search`（官方禁用关键词搜索）
  - 索尼资源：搜索请求 403（换 4 种 UA 均 403），列表接口正常 → 服务端只封搜索通道
  - 闪电 / 鸭鸭 / 牛牛资源：返回纯文本 `暂不支持搜索`
  - 无尽资源：响应极慢，`ac=list` 读超时，换关键词又超时
- `sources.json` 与 `README.md` 已同步。

### 修复
- **搜索源列表后面的「0」胶囊**：由删源解决（无搜索能力的源不再出现），前端 `SearchView.tsx` 按用户要求不改。
- **左侧子站列表最底下一个显示一半**：`.search-source` 写死 `height:30px` 却未禁 flex 压缩，容器高度非整数倍时最后一条被压扁；补 `flex: 0 0 auto`。同时 `.search-sources` 底部 padding 6px → 16px，留出滚动尾巴。
- **横屏设置浮窗过宽**：横屏浮层宽度原本是四套数字（弹幕 `auto` / 选集 `74%` / 设置 `76%` / 直播选台 `78%`）。新增 `--land-sheet-w/min-w/max-w` 令牌，四套统一为 `auto / 320px / 400px`。
- **选台浮窗上滑，亮度/音量跟着滑（手势穿透）**：浮层 DOM 在 `.land-overlay`（绑了 `onStageTouch*`）内部，原先只挡 `onTouchEnd`，`touchstart/touchmove` 冒泡上去被当成屏幕手势。现选台 / 换源条三个 touch 事件全部 `stopPropagation`，并给面板加 `touch-action: pan-y`。连带的「选台面板内部无法滚动」一并解决。
- **直播回看进度条只能点不能滑**：`.ts-bar` 原先只绑 `onClick`。改 pointer 事件（`pointerdown/move/up` + `setPointerCapture`），抽出 `seekByRatio()` 供点击与拖动共用，拖动即时跟手。热区由 4px 撑到 20px（视觉轨道用 `::before` 保持 4px），`bottom` 由 70px 改 62px 保持视觉位置不变；同时拦掉 touch 冒泡，避免被误判为亮度/音量手势。

## V3.5.7

本版继续收口 V3.5.6 剩余的 UI 细节,并新增 F6/F7 两项能力。

### 修复
- **直播横屏底部 4 键空隙太大**：`.landscape .land-bottom` 的 `space-between` 对直播 4 键来说两端太空。现直播横屏(无 `.land-progress`)改用 `justify-content: center; gap: 26px`, 4 键紧凑居中。
- **竖屏中央上一集/下一集尺寸纠正**：由 V3.5.6 的「上下集 32px / 暂停 38px」改回「上下集 38px(= 弹幕圈) / 暂停 46px(大一圈)」。
- **详情卡片标题 / 收藏按钮突出卡片**：`.info-title` 限 2 行裁切; `.info-body` 由 `space-between` 改为自然堆叠; `.fav-btn` margin-top 由 10px 收为 2px, 整体不再超出 poster 高度。
- **详情主演 / 导演信息过长**：`.info-sub` 加 `-webkit-line-clamp: 2`, 信息超长用 `…` 截断。

### 新增
- **F6 直播时移 / 回看**：直播横屏底部新增 `.ts-bar` 时间轴, 点 / 拖即回跳到当前 HLS 直播 `seekable` 缓冲段任意位置; 回看态左上角显示 `⏪ 回看中 mm:ss`, 右上角「回到直播」一键跳回直播边缘。
- **F7 投屏进场自动轮询**：`CastOverlay` 打开后每 5 秒静默重扫 DLNA 设备; 弹窗、设备列表、按钮等 UI 结构 0 改动。

## V3.5.6（播放器横竖屏交互收口）

本版修复 V3.5.5 引入的横屏布局回归，并统一横竖屏播放器的按钮尺寸与片头/片尾交互。

### 修复
- **直播横屏底部按钮跑到左侧竖排**：`.land-bottom` 的 `flex-direction: column`（为点播横屏「上进度条、下工具行」而加）误伤了直播横屏。现用 `:has(.land-progress)` 限定，只作用于点播横屏，直播横屏恢复横向 4 键排布。
- **设置浮层里片头/片尾时间看不见**：`.skip-num` 用 `--accent` 紫色文字，而激活态按钮底色同为 `--accent`，紫字压紫底。现激活态下时间文字跟随按钮前景色（白），清晰可读。

### 变更
- **横屏片头/片尾按钮不再置灰**：去掉 `disabled={!introSec}`。未设置过时点击即以当前进度设定，已设置则直接跳转。
- **横屏片头/片尾补时间显示**：与竖屏一致，设置后按钮上带出 `0:08` 形式的时间。
- **片头/片尾图标方向换回**：片头 = 向左（`skip-back`）、片尾 = 向右（`skip-forward`）。
- **竖屏中央新增上一集/下一集**：与暂停钮组成三连钮，集数 > 1 时显示。

### 尺寸统一
| 位置 | 按钮 | 之前 | 现在 |
|---|---|---|---|
| 竖屏中央 | 暂停 | 60px | 38px（= 左中弹幕圈） |
| 竖屏中央 | 上一集/下一集 | — | 32px |
| 横屏中央 | 暂停 | 64px | 52px |
| 横屏中央 | 上一集/下一集 | 62px | 44px |

---

## V3.5.3（Q 系列：质量与体验）

本版对应《待改进清单》里的 Q 系列，聚焦代码质量与播放健壮性，UI 视觉与 V3.5.2 保持一致。

### Q1 · 播放器拆分 hook（降低回归风险）
- 把 `VideoPlayer.tsx` 里的「缓冲转圈 + 快进加载圈」两套状态机抽到独立 hook `src/video/hooks/useBuffering.ts`，逻辑原封不动、行为不变，渲染与手势解耦。

### Q2 · 版本注释收敛
- 新增本 CHANGELOG，作为版本迭代的权威记录；源码内保留「为什么这么做」的注释，移除冗余的版本戳噪声（逐步进行）。

### Q3 · 清理调试 console 残留
- 新增 `src/lib/log.ts`（dev-only 日志开关：`devLog/devWarn/devError`，仅 `import.meta.env.DEV` 为真时打印，生产构建摇树移除）。
- `SearchView.tsx` / `engine/adapters/js.ts` / `Live.tsx` / `hlsPlayer.ts` 的调试 `console.*` 全部改为 dev-only，出包后不再向终端吐调试信息。

### Q4 · 封面统一走后端代理
- 复核确认全部内容封面（首页卡片、热榜 Banner、搜索、播放、历史、收藏）均已走 `ProxiedImg`（`fetchimage` 后端代理）或 `fetchimage` 直拉；跨源封面另有 `crossCover` 兜底。无裸 `<img>` 直连内容封面（仅源 logo / 应用图标保留原生 `<img>`，属预期）。

### Q5 · 弱网起播失败「重试 / 换源」入口
- 起播失败（缓冲/解析超时、HLS fatal 错误耗尽自动重试）后，错误浮层在「重试」旁新增「换源」按钮：多线路源切到下一线路并重试，单线路源不显示该按钮。

### Q6 · HLS 致命错误限次自动恢复
- `hlsPlayer.ts` 的 `NETWORK_ERROR`（`hls.startLoad`）与 `MEDIA_ERROR`（`hls.recoverMediaError`）加重试上限（各 3 次），避免「转圈→失败→又转圈」死循环；次数耗尽后把后端错误文本交回播放页，由 Q5 的「重试 / 换源」浮层承接，而非静默卡死。

---

## V3.5.2（UI 修复 5 类 9 处）
加载转圈统一 / 卡片白底 / 加载态挤压 / 横屏控件层 / 按钮尺寸。

## V3.5.1（点播改走后端代理 + 播放中常驻缓冲转圈）
点播 m3u8 改走 Rust 后端 `fetchmedia` 代理；播放中常驻缓冲转圈，弱网/冷启动不再静默卡死。

## V3.5.0（HLS.js Loader stats 嵌套对象修复）
补全 `parsing`/`buffering` 嵌套对象，修复 1.6.x 下 `Cannot set properties of undefined` 的 manifestLoadError。

## V3.4.11（直播后端代理）
m3u8 主/子清单改用后端代理（pLoader），直播真正可播。
