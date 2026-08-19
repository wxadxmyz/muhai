# 幕海 MuHai

> 支持 **自定义影视源 + 云盘** 的影视播放器，基于 Tauri 2 的桌面客户端。跨源搜索、跳过片头片尾、弹幕、字幕、投屏、云盘浏览，数据全部本地存储。

> ⚠️ **本仓库只含「框架」，不含任何内置影视源。** 所有源由用户自行在「源管理」中添加（影视 CMS API 适配器、alist 云盘适配器）。请仅添加你拥有合法使用权的资源。

---

## 功能

- 🔌 **可插拔源引擎**：内置 video-cms 适配器与 **alist 云盘适配器**（夸克 / UC / 阿里云盘 / 115 等，通过 Token 接入）。
- 🔍 跨源聚合搜索，结果去重合并（已按媒体类型过滤，避免音视频串味）。
- ⏭️ 播放器：跳过片头/片尾、倍速、多线路切换、弹幕、外挂字幕、投屏（Cast）。
- ☁️ 云盘浏览：alist 文件树浏览，未配置时提供内置演示盘回退，便于体验。
- 📚 本地「收藏 / 历史 / 本地下载」管理。
- 🎨 7 套可切换主题，设置持久化。
- ⌨️ 全局快捷键；🐛 调试面板。

## 技术栈

- 前端：Vite + React + TypeScript
- 桌面端：Tauri 2（Rust）
- 云盘统一层：alist API

## 开发

```bash
pnpm install
pnpm dev          # 浏览器中开发，默认 http://localhost:5173/video.html
```

## 构建桌面安装包（本机）

需先安装 [Rust](https://rustup.rs/) 与系统 WebView 依赖（Linux 需 `libwebkit2gtk-4.1-dev` 等）：

```bash
pnpm tauri dev          # 以桌面窗口运行（开发）
pnpm tauri build        # 产出对应平台的安装包（Windows / macOS / Linux）
```

## 自动化构建（GitHub Actions）

推送带 `v` 前缀的 tag（如 `v0.1.0`）即触发 CI，自动为 **Windows / macOS / Linux** 构建并发布到 GitHub Release。

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Android / iOS（移动端）

仓库已通过 `tauri icon` 生成 Android / iOS 图标资源。完整移动端构建需在本机执行：

```bash
pnpm tauri android init && pnpm tauri android build   # Android
pnpm tauri ios init     && pnpm tauri ios build       # iOS（需 macOS）
```

Android 签名请在 CI 或本机配置 keystore 后打包。

## 许可证

[MIT](./LICENSE)
