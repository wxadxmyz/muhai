fn main() {
    // ⚠️ 这里列的每个命令都必须同时出现在 src-tauri/capabilities/*.json 的 permissions 里
    // （写成 allow-<命令名下划线换连字符>）。漏掉的话：
    //   · 大多数命令会被 Tauri ACL 直接拦下，前端 invoke 报 "Command xxx not allowed by ACL"
    //   · 少数命令（如 media_proxy_port / drpy3run）恰好被 core:default 覆盖，**看起来能用**，
    //     于是漏配这件事会被长期掩盖，直到某个新命令把它暴露出来。
    //   V3.6.5 加 media_proxy_port、V3.6.0 加 drpy3run 时都漏了这一行，属于历史遗漏；
    //   V3.6.8 新增诊断命令才让问题显形。此清单现在与 invoke_handler 保持一一对应。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(&[
                    "fetchsource",
                    "fetchimage",
                    "fetchmedia",
                    "spiderrun",
                    "drpy3run",
                    "dlnascan",
                    "castvideo",
                    "clear_webview_cache",
                    // V3.6.5 就加了、但一直漏在此清单外（靠 core:default 侥幸放行）
                    "media_proxy_port",
                    // V3.6.8 新增：媒体代理运行时诊断
                    "proxy_probe_snapshot",
                    "proxy_probe_clear",
                    "proxy_probe_set_recording",
                    // V3.7.8：网盘登录走 App 内 WebView + 桌面 UA + 注入返回/抓 token 脚本
                    "open_netdisk_login",
                    "close_netdisk_login",
                    // P3：前端在 App 顶层主动取出登录抓到的 token（Rust 侧暂存）
                    "take_netdisk_token",
                    // V4.3.7：局域网推送后端（扫码添加源 / 远程搜索）。此前漏列 → 权限文件未生成、
                    // 且 default.json 也未放行，前端 invoke 直接被 ACL 拦下，报 "Command ... not allowed by ACL"。
                    "start_push_listener",
                    "poll_push_result",
                    "stop_push_listener",
                ]),
        ),
    )
    .unwrap();
}
