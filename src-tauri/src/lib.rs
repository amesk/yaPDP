use tauri::Manager;

/// Read a bundled media image from the app's resource directory.
///
/// The desktop build ships a small set of images (rk0, rk1, bootcode) as
/// bundled resources (see tauri.conf.json -> bundle.resources). The frontend
/// calls this command on startup and mounts the returned bytes into DataLoader
/// so the emulator can boot them offline without any network access.
#[tauri::command]
fn load_bundled_image(app: tauri::AppHandle, name: String) -> Result<Vec<u8>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("cannot locate resource dir: {e}"))?;
    let path = resource_dir.join("media").join(&name);
    std::fs::read(&path).map_err(|e| format!("cannot read bundled image '{name}': {e}"))
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
        .invoke_handler(tauri::generate_handler![load_bundled_image, startup_flags])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
