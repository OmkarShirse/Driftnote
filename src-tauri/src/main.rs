#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Sanitize Snap environment pollution (e.g. VS Code Snap integrated terminal).
    // Snap injects GTK_PATH, GIO_MODULE_DIR, LD_LIBRARY_PATH etc. pointing to /snap/core20,
    // which causes system WebKit subprocesses (WebKitNetworkProcess) to load old snap
    // libpthread.so.0 and crash with missing GLIBC_PRIVATE symbols.
    for var in [
        "GTK_PATH",
        "GIO_MODULE_DIR",
        "LD_LIBRARY_PATH",
        "GDK_PIXBUF_MODULE_FILE",
        "GDK_PIXBUF_MODULEDIR",
        "GTK_IM_MODULE_FILE",
        "LOCPATH",
    ] {
        if let Ok(val) = std::env::var(var) {
            if val.contains("/snap/") || val.contains("/var/lib/snapd/") {
                std::env::remove_var(var);
            }
        }
    }

    // WebKitGTK DMA-BUF renderer workaround for Linux display drivers
    if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    driftnote_lib::run();
}





