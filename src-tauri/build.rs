fn main() {
    // Each command gets an allow-<name> permission; the window's runtime capability
    // (src/lib.rs) grants them to Cockpit's own origin only.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["app_version", "set_theme", "copy_text", "pick_folder"]),
    ))
    .expect("tauri build script");
}
