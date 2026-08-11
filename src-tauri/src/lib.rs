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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_bundled_image])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
