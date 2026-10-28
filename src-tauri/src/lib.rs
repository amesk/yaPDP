use tauri::Manager;

/// Read a bundled resource by its path relative to the resource directory.
///
/// The desktop build ships the disk/tape images, the pre-built machine states
/// and both variant-filtered manifests as Tauri resources (see
/// bundle.resources in src-tauri/tauri.conf.<variant>.json), so all of them
/// live NEXT TO the executable. The frontend, by contrast, is embedded in the
/// binary and compiled once for both variants — which is exactly why anything
/// that differs per variant (the manifest inventory, the state list) must not
/// be baked into it.
///
/// `rel` is confined to the resource directory: the frontend never gets to
/// read an arbitrary file through this command.
fn read_resource(app: &tauri::AppHandle, rel: &str) -> Result<Vec<u8>, String> {
    if rel.is_empty() || rel.contains("..") || rel.contains('\\') || rel.starts_with('/') {
        return Err(format!("refusing bundled resource path '{rel}'"));
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("cannot locate resource dir: {e}"))?;
    let path = resource_dir.join(rel);
    std::fs::read(&path).map_err(|e| format!("cannot read bundled resource '{rel}': {e}"))
}

/// Read a bundled media image ("media/rk0.dsk.zst").
///
/// The frontend calls this on startup and mounts the returned bytes into
/// DataLoader so the emulator can boot them offline without any network access.
#[tauri::command]
fn load_bundled_image(app: tauri::AppHandle, name: String) -> Result<Vec<u8>, String> {
    read_resource(&app, &format!("media/{name}"))
}

/// Read any other bundled resource: a pre-built state
/// ("states/rk0-ready.state.zst") or a manifest ("media/manifest.json",
/// "states/manifest.json").
///
/// States and manifests are resources for the same reason the images are: they
/// are content, not UI, they differ per installer variant, and they must be
/// reachable without an HTTP server — the packaged app has no HTTP path to
/// `states/` or `media/` at all.
#[tauri::command]
fn load_bundled_file(app: tauri::AppHandle, rel: String) -> Result<Vec<u8>, String> {
    read_resource(&app, &rel)
}

/// Process arguments the frontend is allowed to see.
///
/// Only long options are exposed: the service mode is entered with
/// `--maintenance`, and the executable path or stray file names never leave
/// the Rust side. The frontend asks once on startup (src/maintenance.js) and
/// treats the flag exactly like `?maintenance=1`.
#[tauri::command]
fn startup_flags() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| arg.starts_with("--"))
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_bundled_image,
            load_bundled_file,
            startup_flags
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
