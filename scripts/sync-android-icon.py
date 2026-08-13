#!/usr/bin/env python3
"""Tauri v2 Android 图标同步脚本。

问题：Tauri v2 的 `bundle.icon` 只管桌面端（icns/ico），
不会把 src-tauri/icons/icon.png 自动同步到 Android 模板项目的
mipmap launcher 图标。结果 APK 里用的是 Tauri 模板默认占位图。

本脚本在 `tauri android init` 生成 gen/ 之后、`tauri android build` 之前运行，
把自定义 icon.png 缩放成各密度并覆盖 gen/ 下的 ic_launcher*.png，
同时把 adaptive icon 的 background 设为透明，避免出现背景色块叠加。

用法（CI 中）：python3 scripts/sync-android-icon.py
依赖：Pillow （CI 步骤里先 `python3 -m pip install pillow`）
"""
import os

try:
    from PIL import Image
    try:
        RESAMPLE = Image.Resampling.LANCZOS
    except AttributeError:
        RESAMPLE = Image.LANCZOS
except ImportError:
    Image = None

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SRC_ICON = os.path.join(REPO_ROOT, "src-tauri", "icons", "icon.png")
GEN_RES = os.path.join(
    REPO_ROOT, "src-tauri", "gen", "android", "app", "src", "main", "res"
)

DENSITIES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

# 模板里可能出现的 launcher 图标文件名（只覆盖已存在的，不新建）
LAUNCHER_NAMES = (
    "ic_launcher.png",
    "ic_launcher_round.png",
    "ic_launcher_foreground.png",
    "ic_launcher_monochrome.png",
)


def main():
    if Image is None:
        raise SystemExit("Pillow 未安装：请先 `python3 -m pip install pillow`")
    if not os.path.isfile(SRC_ICON):
        print(f"[skip] 源图标不存在: {SRC_ICON}")
        return
    if not os.path.isdir(GEN_RES):
        print(f"[skip] gen/res 不存在（请先运行 `tauri android init`）: {GEN_RES}")
        return

    im = Image.open(SRC_ICON).convert("RGBA")
    count = 0
    for folder, size in DENSITIES.items():
        d = os.path.join(GEN_RES, folder)
        if not os.path.isdir(d):
            continue
        thumb = im.resize((size, size), RESAMPLE)
        for name in LAUNCHER_NAMES:
            p = os.path.join(d, name)
            if os.path.exists(p):
                thumb.save(p)
                count += 1
                print(f"[ok] {os.path.relpath(p, REPO_ROOT)}")
        # adaptive icon 的 background 设为透明，避免背景色块叠在带背景前景上
        bg = os.path.join(d, "ic_launcher_background.xml")
        if os.path.exists(bg):
            with open(bg, "w") as f:
                f.write('<?xml version="1.0" encoding="utf-8"?>\n')
                f.write('<resources>\n')
                f.write('  <color name="ic_launcher_background">#00000000</color>\n')
                f.write('</resources>\n')
            print(f"[ok] {os.path.relpath(bg, REPO_ROOT)} -> 透明背景")

    print(f"完成：已同步 {count} 个 launcher 图标")


if __name__ == "__main__":
    main()
