#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Sanitize LD_LIBRARY_PATH if running inside a Snap environment (e.g. VS Code Snap).
    // Snap injects old core20 libpthread/glibc paths into the environment, which breaks
    // system WebKit subprocesses (WebKitNetworkProcess) on modern Ubuntu.
    if let Ok(ld) = std::env::var("LD_LIBRARY_PATH") {
        let cleaned: Vec<&str> = ld
            .split(':')
            .filter(|p| !p.contains("/snap/") && !p.contains("/var/lib/snapd/"))
            .collect();
        if cleaned.is_empty() {
            std::env::remove_var("LD_LIBRARY_PATH");
        } else {
            std::env::set_var("LD_LIBRARY_PATH", cleaned.join(":"));
        }
    }

    driftnote_lib::run();
}




