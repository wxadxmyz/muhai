fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(&[
                    "fetchsource",
                    "fetchimage",
                    "spiderrun",
                    "dlnascan",
                    "castvideo",
                    "clear_webview_cache",
                ]),
        ),
    )
    .unwrap();
}
