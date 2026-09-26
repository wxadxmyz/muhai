# 幕海 MuHai 更新日志（CHANGELOG）

> 代码内只保留「为什么这么做」的注释；版本迭代的权威记录统一收敛到此文件，不再在源码里满屏写 `V3.x.x` 行内标记。
> 版本号同时维护在 `package.json` 与 `src-tauri/tauri.conf.json`。

---

## V3.8.5

本版修复 V3.8.4 真机复测中 drpy 源**「能搜索、点播仍报『未取到可播放地址』」**的残留问题（仅部分 drpy 源在「从搜索/分类列表卡片直接起播」时触发，进详情页再播放反而正常）。

### 根因

`drpy3.ts` 的 `toItems`（搜索/分类列表用）此前用**未排序**的 `toEpisodesWithFlag` 摊平选集；而部分 drpy 源的 `vod_play_from` 把「分享页线路」排在「直链线路」之前（如量子资源 lzi：`"liangzi$$$lzm3u8"`）。于是列表卡片记下的首集是 **liangzi 分享页 URL**（该线路实测已失效/返回 404），点卡片直接起播时 `firstEpMap` 命中这条死链 → `play` 去死链抠 m3u8 失败 → 弹「未取到可播放地址」。详情页因走按直链占比排序的 `toLineGroups`（lzm3u8 优先），所以反而能播——与「搜索能、点播挂」的现象完全吻合。

### 修复

- `toItems` 改用与详情一致的 `toLineGroups`（按直链占比排序、线路名作 flag）解析自带选集，使搜索/分类卡片的首集也**直链优先**，可直接起播且省一次详情往返。
- `getPlayUrl` 强化首集消费：当缓存首集是「分享页 / 中间地址」（`playId` 非 `.m3u8/.mp4` 直链）时，主动回退 `detail` 用 `toLineGroups` 重选直链占比最高的线路；即便首集被记成死链也能救回，不再把脏数据丢给播放器。

> 沿用 V3.8.4 的 `--split-per-abi` 打包，产出 `arm64-v8a` + `armeabi-v7a` 两个真机包，覆盖新机型与老机型。

---

## V3.8.4

本版修复 V3.8.3 真机验证中暴露的 **drpy 源「能搜不能播」** 回归，并把安装包显著瘦身（三项）。

### A. 修复 drpy 源「能搜不能播」

- `src/engine/adapters/drpy3.ts`：`detail` 解析对齐苹果 CMS normal 源（按 `vod_play_from` 构造 `lineGroups/lineNames`，直链线路优先）；`getPlayUrl` 强制兜底拉 `detail` 取真实首集 URL（当 `playId` 不是合法 http(s) URL 时不再把 `vod_id` 当 URL 丢给播放器）；`play()` 返回非 URL 时显式报错而非无限转圈。

### B. 安装包瘦身（三项）

- 移除 `tauri-plugin-shell`：`Cargo.toml` 去依赖、`src-tauri/src/lib.rs` 去 `.plugin()` 初始化、两份 capabilities 删 `shell:allow-open` 权限声明（前端零引用，纯删冗余 ~10MB）。
- `src-tauri/Cargo.toml` 追加 `[profile.release]`：`opt-level="z"` + `lto=true` + `strip=true`，单份 `libapp_lib.so` 再降约 20%~25%。
- `.github/workflows/android.yml` 构建命令加 `--split-per-abi`，产物从单个 universal APK 改为按 ABI 拆分的多个 APK（arm64-v8a / armeabi-v7a / x86 / x86_64）；签名与上传步骤改为循环处理多 ABI 包。arm64 单包体积预计由 ~99MB 降到 ~20~25MB。

> 注：瘦身三项均不涉及播放/drpy 逻辑，与 A 项功能修复互不干扰。

---

## V3.8.3

本版聚焦「**只留苹果 CMS（normal 型）+ drpy 两类源**」的精简，并把即使只用这两类源也仍然存在的播放链路 BUG 修掉。csp 体系（JS 型 csp 与 Phase 2 原生 DEX 桥）从代码里干净移除。

### A. 移除影视仓 csp 体系

- 删除 Phase 2 脚本 `scripts/patch-csp-android.sh` 及 CI 调用（Kotlin `MuHaiCsp` / `CspNative` / `Init` / `Java` DEX 桥整段移除）。
- `src-tauri/src/js_engine.rs`：删 `__native_csp` 分支、csp 管理器下载+md5 校验、catvod `java` 宿主兼容层与 csp 专用字段；保留 QuickJS 沙箱与 drpy2 引擎核心。
- `src/engine/adapters/tvbox.ts`：删 `isCspSite` / `spiderField` / 所有 `csp_` 选路分支；保留 normal/drpy 解析与 `$$$` 多线路分组。
- `src/engine/adapters/js.ts`：删 `MuHaiCsp.require` 路由与 `__native_csp` 锁定。
- `src/engine/types.ts`：删 `CspSourceConfig` 接口；`'csp'` 枚举字面量保留（避免历史配置反序列化报错），不再有新代码引用。
- `src/engine/index.ts`：`case 'csp'` 显式抛错提示「csp 源已在 V3.8.3 移除」。

### B. 修复播放链路（苹果 CMS / drpy 同样受益）

- **m3u8 探测崩溃**：`src/lib/hlsPlayer.ts` 的 `createBackendLoader` 在 `Range: bytes=0-0` 畸形探测头（`rangeStart===0 && rangeEnd===0/''/null`）时不再发送 Range 头，改为普通 GET，避免 hls.js 按 1 字节解析导致 `fragParsingError` 卡死。
- **云线路 WebView 转圈**：`src/engine/adapters/normal.ts` 的 `resolvePlayUrl` 增加苹果 CMS「云」线路 HTML 藏链兜底（正则匹配 `const vid='.../index.m3u8'` 等），抠出真实 m3u8 再走正常播放；解析失败改为显式报错（而非把 HTML 交给播放器无限转圈）。页面抓取补 `Referer` + 浏览器 UA。

> APK 体积预期回落：移除了 Phase 2 引入的 Kotlin DEX 桥；后续按 `安装包瘦身清单.md` 在 V3.8.4 继续三项瘦身。

## V3.6.6

本版修「**播放加载 10 秒不出片**」（四个真 BUG 中的两个致命项）、首页**冷启动白屏**、设置页边距不一致，并整理 gitee 三仓库结构。四项一次性做完。

### A. 播放卡死根治（A1 / A2 两个致命 BUG）

现象：搜到影片后，用三个不同子站（豪华 / 红牛 / 光速）点播放，都停在「加载中」10 秒以上不出画面。服务端实测三源的 API、分享页、真实 m3u8、AES 密钥**全部 HTTP 200 正常**——所以不是源的问题，是客户端取流方式错。

- **A1 · Referer 用了 API 域名（致命）**：`adapters/normal.ts` 的 `getPlayUrl` 原来把 `Referer` 固定设成苹果CMS **API 域名**（如 `hhzyapi.com/`）。但真实播放地址在**另一个域名**（如 `play.hhuus.com`），而这类源普遍开了防盗链校验。Referer 与播放域名不同源 → CDN 直接拒绝 → hls.js 永远拿不到第一个分片 → 永远「加载中」。
  - 改为**从最终播放地址推导 `origin`** 作 Referer；解析失败才退回 API 域名。
- **A2 · m3u8 内相对路径经代理后解析错（致命）**：番剧普遍是 **AES-128 加密 HLS**，m3u8 里写着 `#EXT-X-KEY:METHOD=AES-128,URI="enc.key"` —— 这是**相对路径**，hls.js 会相对 m3u8 自身 URL 解析。而 V3.6.5 的本地流式代理把 m3u8 转发给前端时，**没有改写这些相对路径**，hls.js 便按 `127.0.0.1:临时端口/enc.key` 去取密钥 → 404 → 无法解密 → 卡死。
  - `src-tauri/src/lib.rs` 新增 `rewrite_m3u8_paths(text, base)`：逐行处理，把标签内 `URI="..."` 与纯路径行补成**基于 m3u8 真实地址（跟随重定向后的 `X-Proxy-Final-Url`）的绝对地址**；`//`、`data:`、`blob:` 与已是绝对地址的保持不变。
  - `proxy_handler` 新增 m3u8 分支：`Content-Type` 含 `mpegurl` 或 URL 含 `.m3u8` 时走「读文本 → 重写 → 返回整包」；其余（ts/mp4）仍走流式，Range 拖动不受影响。
  - 已用真实数据验证：豪华源 `URI="enc.key"` → `https://play.hhuus.com/play/e3191Jrb/enc.key` ✅；光速源 `/play/hls/eZ6W6Xve/index.m3u8` → `https://v.gsuus.com/play/hls/eZ6W6Xve/index.m3u8` ✅。

> 说明：三个源是**同一套 CMS 模板**（分享页 / AES 加密 / 防盗链逻辑完全一致），所以「换源」根本无效——换哪个都撞同两个 BUG。

### B. 首页冷启动白屏 → 扩散涟漪加载动画

- **根因 1**：`Home.tsx` 是 `{hotData && (...)}`——数据未到时**整块不渲染**，首页只剩顶栏 + 大片空白。冷启动 `hotCache` 为空，必然走网络。
- **根因 2**：主备链**串行**尝试，最坏 ≈ 8s + 8s = 16s 白屏。
- 改法：
  - 新增 `components/LoadingSpinner.tsx`：3 环依次扩散 + 中心光点呼吸，全 CSS 动画（合成层，不卡主线程）、颜色走 `--accent/--accent2` 自动跟随主题，并尊重 `prefers-reduced-motion`。
  - `hotData` 为 null 时渲染该动画（`LoadingSpinner label="正在加载内容…"`），不再留白。
  - **最小显示时长 300ms**：数据秒回时不让动画「闪一下就没」（比慢更显廉价）。
  - **SWR 首帧**：`useState(() => hotCache ?? cacheReadStale())`——模块缓存未命中时读 localStorage 里的过期缓存先渲染，后台再静默刷新。宁可显示 12 小时前的热榜，也好过对着空白等 4 秒。
  - **主备链并行竞速**：`fetchOne` 超时 `8s → 4s`，两条链同时发、谁先成功用谁（`Promise.any` + 手写兜底），最坏耗时由 ~16s 降到 ~4s；两条都失败再回退任何已有缓存。

### C. 设置页左右边距与仓库管理页对齐

- **上次改错的两点**：① 选择器 `.fullpage-body .settings-scroll` **根本不匹配**——设置页 DOM 里没有 `.fullpage-body`（那是 SubPage 的内部结构）；② 注释把方向写反了。
- **真实根因**：移动端 `.app .main:not(.main-live)` 给了左右 14px，`.settings-scroll` 自己又 `padding: 14px` → 叠加 **28px**，而仓库管理页走 `.fullpage-body` 路径只有 14px。
- 改法：删掉那条无效规则，在 `@media (max-width: 820px)` 内补 `.settings-scroll { padding-left: 0; padding-right: 0; }`，由外层统一给 14px。

### D. gitee 三仓库结构整理

目标结构（已用令牌执行完毕）：

| 仓库 | 内容 |
|---|---|
| **muhai-vod**（幕海点播） | `sources.json`（16 站苹果CMS点播源）、`drpy-sources.json` + `rules/`（7 个 drpy 规则源，搜索主力）、`hot.json`（APP 自动拉取首页热门）、README |
| **muhai-live**（幕海直播） | `lives.json` + `tv.m3u`（静态 m3u 源，自动加载）、`drpy-live-sources.json` + `lib/`（虎牙/斗鱼/兔小贝 明文规则，需手动订阅）|
| **lvyun-sources**（律云音源） | 未改动 |

具体动作：
- **合并** `acms-all.json` → `sources.json`（并集去重，剔除实测不稳的 `wujin`），统一为唯一点播入口。
- **迁出直播**：`drpy-live-sources.json` 与 `live/`（huya/douyu/tuxiaobei）→ muhai-live。
- **删除无引用遗留**：`lib/`（5 个）、`cms.js`、`xb6v.js`、`xb6v_v3.js`、`rules/lizi.js`、`changelog-v3.2.4.md`、`v3.2.4-改动清单.md`。
- muhai-live 侧：用**明文** `huya.js` 替换引擎无法解析的 `**<base64>` 加密版 `huya2.js`；删除与 `douyu.js` 完全相同的 `斗鱼直播.js`；删除无引用的 `backup-20250425.m3u`。
- 两仓 README 重写，与整理后的文件结构完全对齐（含「两类加载方式不同」的明确提醒）。
- 验证：4 个订阅地址全为合法 JSON，10 个 `spiderUrl` 全部 HTTP 200 可达。

### 改动文件

`src-tauri/src/lib.rs`、`src/engine/adapters/normal.ts`、`src/styles.css`、`src/lib/hot.ts`、`src/video/views/Home.tsx`、`src/components/LoadingSpinner.tsx`（新增）

---

## V3.6.5

本版根治「播放卡顿 / 转圈」（架构级），并把搜索体感、drpy 适配器 4 项缺口、下载持久化、设置页 UI 一致性**一并修完**，不做挤牙膏式分版本。

### 播放根治：Rust 本地流式 HTTP 代理（替换 base64 全量过桥）
- **根因**：所有走后端代理的播放（drpy / 苹果 / 直播）都经 `fetchmedia`——把整段响应读进内存 → base64 编码 → JSON 过桥 → 前端 atob 解码。hls.js 无法边下边播、无法预取下一分片，也不支持 HTTP Range。表现：drpy 一直转圈、苹果源「播 2 秒卡好久」、mp4 无法拖动。
- **改法**：`src-tauri/src/lib.rs` 新增 `127.0.0.1` 临时端口流式代理（`media_proxy_port` / `serve_proxy` / `proxy_handler`），透传 Range / Referer / UA，响应以 `bytes_stream()` 逐帧 pipe 回 WebView，并回传 `X-Proxy-Final-Url`（跟随重定向后的真实地址）。旧 `fetchmedia` 保留作图片 / 兜底。
- `src/lib/hlsPlayer.ts`：`ensureProxyPort()` + `buildProxyUrl()` 改写媒体 URL；`createBackendLoader` / `peekIsHls` / `attachHlsWithBackend` 全部改走本地回环，mp4 直链支持 Range 拖动。
- 安卓：`android.yml` 注入 `network_security_config.xml` 并在 `<application>` 引用，放行 `127.0.0.1` / `localhost` 明文回环（Android 9+ 默认禁明文）。

### 搜索体感
- 单源超时 `10s → 6s`（`engine/index.ts` / `SearchView.tsx`）。
- **进度文案**：`aggregateSearch` 新增 `onProgress(done, total)`，spinner 显示「已返回 N 个源，仍有 M 个搜索中…」，替换恒定的「跨源搜索中…」。
- **源健康记忆**：localStorage `muhai_src_health` 记录每个源连续失败次数；≥3 次的死源直接跳过、失败过的源降到 3s 超时，重复搜索秒出。

### drpy 适配器 4 项缺口全补
- **#1 jx/parse 二次解析**：`getPlayUrl` 识别 `r.jx` / `r.parse`，为真时把中间地址经本地代理 fetch，用 `x-proxy-final-url` 取真直链（覆盖绝大多数"jx 重定向到真实 CDN"的源）。旧实现只取 `r.url` 直接返回，拿到的是中间页。
- **#2 搜索分页**：`aggregateSearch` 接收 `page` 并透传 `search(keyword, page)`；搜索页加「加载更多」按钮（按 `id|sourceName` 去重追加）。
- **#3 规则缓存复用**：`js.ts` 加模块级 `rawCodeCache`，跨搜索重建实例时不再每次 `invoke('fetchsource')` 重拉 gitee 规则。
- **#4 播放去重详情**：`drpy3.ts` 加首集映射 `firstEpMap`；`toItems` 就地解析列表里的 `vod_play_url`（列表卡片可直接显示集数），播放时复用首集，省掉每次播放多出的一次 `detail` 往返。

### 其它
- **下载任务持久化**（C 项）：`downloads.ts` 任务列表（含进度）落盘 localStorage，进行中节流落盘、终态立即落盘；启动恢复，退出时仍在进行的任务如实标记为「已中断」而非假装在下载；已中断任务可重新下载。
- **设置页边距对齐仓库管理页**：`.fullpage-body .settings-scroll { padding: 4px 0 0 }`，去掉双层叠加的 28px，与仓库管理页一致为 14px。

> A（源管理文案）/ B（更新检查跳转）/ D（统一错误边界）/ E（安全区）经评估本版暂缓，留待后续版本。

---

## V3.6.4

本版把 drpy3 引擎真正跑通「影视仓可用源」（搜索 + 播放全链路可用），不做挤牙膏式分版本修补。

### 引擎层（`src-tauri/vendor/drpy3-muhai.bundle.js` 由上游 `hjdhnx/drpy3` 最新 src 重建）
- **#1 360 点进去没集数**：`defaults.detail` 原把 `fyclass` 占位符替换成空串，导致 360 详情接口缺 `cat` 参数返回 `data:null`。改为当 `fullId` 含 `$` 且确属剥过分类前缀时，用首段回填 `fyclass`。
- **#9 片段作用域缺口**：`jsFragment` 漏注入 drpy2 经典辅助 `urljoin2` / `buildUrl`，以及一二级片段所需的 `cateObj` / `MY_CATE` / `HOST`。补齐后 s360 详情/播放全通（eps=22，play 返回 iqiyi 真实地址），bili 一级不再 `cateObj is not defined`。

### 外壳层（`src/engine/adapters/drpy3.ts`）
- **#3 裸 VOD 兜底**：部分 drpy2 源 `detail` 直接返回裸 VOD 对象（不带 `{list:[...]}` 包裹），兜底把 `r` 自身当单条结果，避免详情页凭空为空。
- **#4 错误显化**：`getDetail` 检查引擎返回的 `__drpy3_error` 并抛出，与 `search` / `getPlayUrl` 行为一致，前端不再把「引擎崩了」误判成「源没数据」。
- **#5 Referer 修正**：`getPlayUrl` 的 Referer 改用源真实 host（规则脚本里的 `host` / `ext` / `api`），去掉原来误用 `cfg.baseUrl`（那是 gitee 规则文件地址，不是媒体站）导致 360kan / iqiyi 等拒绝播放的 bug。
- **#7 参数对齐**：`search(keyword, false, page)` 已与上游 `search(wd, quick, pg)` 对齐，复核确认无需改动。

### 源仓库（gitee xmyzjxn/muhai-vod）
- 保持 7 个搜索型活源（s360 / lzi / rebo / duonao / changzhang / ikanbot / bili），「我的哔哩」经 `ghproxy.net` 直连绕过风控（#6）。
- 沙箱机房 IP 对 lzi/rebo/duonao 不可达、changzhang/ikanbot 被 Cloudflare 拦属真机环境差异，引擎层已无障碍；真机可正常拉取与播放。

---

## V3.6.3

本版一次性修好「导入 drpy 源后搜不了影视」：换用国内可达的活源、直播源拆出、单源失败不再报警阻断。

### 源仓库（gitee xmyzjxn/muhai-vod）
- `drpy-sources.json` 重写为 4 个国内可达的 drpy2 规则活源（豆瓣 / 荐片 / 爱看机器人 直连 gitee；我的哔哩经 ghproxy 代理），移除失效的芒果规则。
- 新增 `drpy-live-sources.json`，把虎牙 / 斗鱼 / 兔小贝三个直播规则源从点播清单拆分出去。

### App 容错（SearchView.tsx / styles.css）
- 单源搜索失败：左侧源栏不再红色「!」报警、不暴露 `forEach of undefined` 等技术栈错误，改为灰色「暂」标记 + 友好提示。
- 主区「该源未连通」大窗改为「该源暂不可用」友好提示。
- 单源失败不阻断其它源结果（挂掉的源灰掉即可）。

---

## V3.6.2

本版修复 **安卓端 drpy3 命令被 ACL 拒绝** 的致命问题（V3.6.1 实际可用性 bug）。

### 修复
- **Tauri ACL 放行 `drpy3run`**：
  - V3.6.0/V3.6.1 在 Rust 侧注册了 `drpy3run` 命令，但**未在移动端 capability 与 permission 清单中显式放行**。桌面端 ACL 默认宽松可以跑，安卓端严格执行 ACL，导致调用 `drpy3run` 时直接报错 `Command drpy3run not allowed by ACL`，drpy 源全部显示「该源未连通」，搜索/首页/详情/播放均失败。
  - 新增 `src-tauri/permissions/autogenerated/drpy3run.toml`（`allow-drpy3run` / `deny-drpy3run`）。
  - 在 `src-tauri/capabilities/default.json`（android/iOS）与 `desktop.json`（桌面端）的 `permissions` 数组中追加 `"allow-drpy3run"`，与 `allow-spiderrun` 等自定义命令保持一致。

### 验证
- `cargo check` 通过：Tauri 构建期正确识别 `allow-drpy3run`，不再报 `Permission allow-drpy3run not found`。

---

## V3.6.1

本版修复 **drpy 聚合源无法直接导入** 的问题（P0 收尾），让 V3.6.0 接入的 drpy 引擎真正可被用户用起来。

### 修复
- **导入订阅时自动展开 drpy 站点**（`src/lib/sourceFetch.ts`）：
  - 此前 TVBox 聚合配置（含 `sites[]`）被整体当作「一个」tvbox 源，drpy 子站被吞掉；且若 drpy 规则被内联进 JSON，会撞上 App 的注释清洗导致 JSON 解析失败 → 提示「未识别到可用的源配置」。
  - 新增 `expandSites()`：导入时把 `sites` 里**每个 drpy 规则源（spider / spiderUrl / `api=框架+ext=规则` 指向 `.js`）展开成独立的 `type:'js'` 源**；`csp_*` Dex 蜘蛛确定跑不了，自动跳过；纯 tvbox 聚合仍保持「整体单源」旧行为以兼容。
  - drpy 站点用 `ext`/远程规则 URL 当 `spiderUrl` 加载（框架由 drpy3 引擎自带，忽略 TVBox 的 `api` 框架字段），不再内联规则，从而避免注释清洗破坏 JSON。
- **gitee 点播源仓库**：`drpy-sources.json` 改为不内联（芒果TV 规则入库为 `rules/mgtv-dr2.js` 远程加载），并新增虎牙/斗鱼/兔小贝 3 个直播 drpy2 源；当前共 5 源（2 点播 + 3 直播）。

### 验证
- node 复现 `expandSites`：对 `drpy-sources.json`（5 源）与用户 `ysc.txt`（48 站）分别展开，前者全展开为 5 个 js 源，后者正确展开 3 个 drpy 直播源、跳过 45 个 csp 蜘蛛。
- gitee raw 链接实测可达：`drpy-sources.json`、`rules/mgtv-dr2.js` 均 `HTTP 200 / text/plain`，App 端 `fetchsource` 代理可拉取。

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
