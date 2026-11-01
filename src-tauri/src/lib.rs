use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

const READ_EXTS: &[&str] = &["md", "canvas", "png", "jpg", "jpeg", "gif", "webp", "svg"];
const WRITE_EXTS: &[&str] = &["md", "canvas"];
const TRASH_DIR: &str = ".driftnote-trash";
const MAX_READ_TEXT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_READ_BINARY_BYTES: u64 = 50 * 1024 * 1024;
const MAX_DEPTH: usize = 2;
const MAX_ENTRIES: usize = 20000;
const MAX_WATCH_DIRS: usize = 500;

static TRASH_COUNTER: AtomicU64 = AtomicU64::new(0);

fn current_timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

fn canonicalize_path(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        c
    } else if let (Some(parent), Some(name)) = (p.parent(), p.file_name()) {
        if let Ok(parent_canon) = parent.canonicalize() {
            parent_canon.join(name)
        } else {
            p.to_path_buf()
        }
    } else {
        p.to_path_buf()
    }
}

#[derive(Default)]
pub struct AppState {
    pub root_dir: Mutex<Option<PathBuf>>,
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    pub recent_writes: Mutex<HashMap<PathBuf, Instant>>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub mtime: u64,
    pub children: Option<Vec<FileNode>>,
}

#[derive(Serialize, Clone)]
pub struct FsChangeEvent {
    pub paths: Vec<String>,
}

fn get_config_file(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed getting app config directory: {e}"))?;
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed creating app config directory: {e}"))?;
    Ok(config_dir.join("last_root.txt"))
}

fn save_persisted_root(app: &AppHandle, path: &Path) {
    if let Ok(file_path) = get_config_file(app) {
        let _ = fs::write(file_path, path.to_string_lossy().as_bytes());
    }
}

fn load_persisted_root(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let file_path = match get_config_file(app) {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    if !file_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed reading saved workspace config: {e}"))?;
    let path = PathBuf::from(content.trim());
    if path.is_dir() {
        Ok(Some(path))
    } else {
        let _ = fs::remove_file(&file_path);
        Err(format!(
            "Configured workspace directory '{}' no longer exists",
            path.display()
        ))
    }
}

fn validate_and_open_read(root: &Path, rel_path: &str) -> Result<(File, PathBuf), String> {
    let rel = Path::new(rel_path);
    for comp in rel.components() {
        match comp {
            Component::ParentDir => return Err("Parent directory traversal rejected".into()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("Absolute path notation rejected".into())
            }
            Component::Normal(s) => {
                if s.to_string_lossy().starts_with('.') {
                    return Err("Hidden path component rejected".into());
                }
            }
            _ => {}
        }
    }

    let ext = rel
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .ok_or_else(|| "Missing file extension".to_string())?;

    if !READ_EXTS.contains(&ext.as_str()) {
        return Err(format!("File extension .{ext} not permitted for read"));
    }

    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("Invalid workspace root: {e}"))?;
    let target = root.join(rel);

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&target)
        .map_err(|e| format!("Path inaccessible or symlink rejected: {e}"))?;

    let meta = file
        .metadata()
        .map_err(|e| format!("Failed reading file metadata: {e}"))?;
    if !meta.is_file() {
        return Err("Target is not a regular file".into());
    }

    let fd_link = format!("/proc/self/fd/{}", file.as_raw_fd());
    let resolved_path = fs::read_link(&fd_link)
        .map_err(|e| format!("Failed inspecting descriptor path: {e}"))?;

    if !resolved_path.starts_with(&root_canon) {
        return Err("Target escapes workspace root boundary".into());
    }

    Ok((file, resolved_path))
}

fn validate_write_target(root: &Path, rel_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let rel = Path::new(rel_path);
    for comp in rel.components() {
        match comp {
            Component::ParentDir => return Err("Parent directory traversal rejected".into()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("Absolute path notation rejected".into())
            }
            Component::Normal(s) => {
                if s.to_string_lossy().starts_with('.') {
                    return Err("Hidden path component rejected".into());
                }
            }
            _ => {}
        }
    }

    let ext = rel
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .ok_or_else(|| "Missing file extension".to_string())?;

    if !WRITE_EXTS.contains(&ext.as_str()) {
        return Err(format!("File extension .{ext} not permitted for write"));
    }

    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("Invalid workspace root: {e}"))?;
    let target = root.join(rel);

    let parent = target
        .parent()
        .ok_or_else(|| "Target path has no parent directory".to_string())?;
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("Parent directory inaccessible: {e}"))?;

    if !parent_canon.starts_with(&root_canon) {
        return Err("Target parent directory escapes workspace root boundary".into());
    }

    if target.exists() {
        let meta = fs::symlink_metadata(&target)
            .map_err(|e| format!("Failed checking metadata: {e}"))?;
        if meta.file_type().is_symlink() {
            return Err("Target path is a symlink, write rejected".into());
        }

        let target_canon = target
            .canonicalize()
            .map_err(|e| format!("Target path canonicalization failed: {e}"))?;
        if !target_canon.starts_with(&root_canon) {
            return Err("Target escapes workspace root boundary".into());
        }
        Ok((parent_canon, target_canon))
    } else {
        Ok((parent_canon, target))
    }
}

fn file_mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[tauri::command]
async fn pick_root(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] pick_root");
    let app_handle = app.clone();
    let folder = tauri::async_runtime::spawn_blocking(move || {
        app_handle
            .dialog()
            .file()
            .set_title("Select Notes Workspace")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    let res = match folder {
        Some(path_response) => {
            let path = path_response
                .into_path()
                .map_err(|_| "Invalid directory selection".to_string())?;
            let canonical = path
                .canonicalize()
                .map_err(|e| format!("Folder path canonicalization failed: {e}"))?;
            save_persisted_root(&app, &canonical);
            let display_name = canonical.to_string_lossy().to_string();
            {
                let mut guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
                *guard = Some(canonical);
            }
            let _ = start_watch_internal(&app, &state);
            Ok(display_name)
        }
        None => Err("Folder selection canceled".into()),
    };
    eprintln!("[{}] [END] pick_root (success={})", current_timestamp(), res.is_ok());
    res
}

#[tauri::command]
async fn list_tree(state: State<'_, AppState>) -> Result<FileNode, String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] list_tree");
    let canonical_root = {
        let guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
        let root = guard
            .as_ref()
            .ok_or_else(|| "No workspace folder selected".to_string())?;
        root.canonicalize()
            .map_err(|e| format!("Root folder read error: {e}"))?
    };

    let res = tauri::async_runtime::spawn_blocking(move || {
        let mut entry_count: usize = 0;

        fn scan(
            dir: &Path,
            root: &Path,
            depth: usize,
            counter: &mut usize,
        ) -> Result<Vec<FileNode>, String> {
            if depth > MAX_DEPTH || *counter >= MAX_ENTRIES {
                return Ok(Vec::new());
            }

            let mut nodes = Vec::new();
            let entries = match fs::read_dir(dir) {
                Ok(rd) => rd,
                Err(_) => return Ok(Vec::new()),
            };

            for entry_res in entries {
                if *counter >= MAX_ENTRIES {
                    eprintln!(
                        "[{}] [WARN] list_tree exceeded MAX_ENTRIES ({})",
                        current_timestamp(),
                        MAX_ENTRIES
                    );
                    break;
                }
                let Ok(entry) = entry_res else { continue };
                let Ok(ft) = entry.file_type() else { continue };

                if ft.is_symlink() {
                    continue;
                }

                let file_name = entry.file_name().to_string_lossy().to_string();
                if file_name.starts_with('.') || file_name == TRASH_DIR {
                    continue;
                }

                let path = entry.path();
                let rel_path = match path.strip_prefix(root) {
                    Ok(r) => r.to_string_lossy().to_string(),
                    Err(_) => continue,
                };

                *counter += 1;

                if ft.is_dir() {
                    let children = scan(&path, root, depth + 1, counter)?;
                    nodes.push(FileNode {
                        name: file_name,
                        path: rel_path,
                        kind: "directory".into(),
                        mtime: file_mtime(&path),
                        children: Some(children),
                    });
                } else if ft.is_file() {
                    let ext = path
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_ascii_lowercase())
                        .unwrap_or_default();

                    if READ_EXTS.contains(&ext.as_str()) {
                        nodes.push(FileNode {
                            name: file_name,
                            path: rel_path,
                            kind: "file".into(),
                            mtime: file_mtime(&path),
                            children: None,
                        });
                    }
                }
            }

            nodes.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
                ("directory", "file") => std::cmp::Ordering::Less,
                ("file", "directory") => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });
            Ok(nodes)
        }

        let children = scan(&canonical_root, &canonical_root, 0, &mut entry_count)?;
        let root_name = canonical_root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Workspace")
            .to_string();

        Ok(FileNode {
            name: root_name,
            path: String::new(),
            kind: "directory".into(),
            mtime: file_mtime(&canonical_root),
            children: Some(children),
        })
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    eprintln!("[{}] [END] list_tree (success={})", current_timestamp(), res.is_ok());
    res
}

#[tauri::command]
async fn read_text(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] read_text path={path}");
    let root = {
        let guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .ok_or_else(|| "No workspace folder selected".to_string())?
            .clone()
    };

    let res = tauri::async_runtime::spawn_blocking(move || {
        let (mut file, _) = validate_and_open_read(&root, &path)?;
        let meta = file
            .metadata()
            .map_err(|e| format!("Metadata error: {e}"))?;
        if meta.len() > MAX_READ_TEXT_BYTES {
            return Err("File size exceeds 20 MB limit".into());
        }

        let mut content = String::new();
        file.read_to_string(&mut content)
            .map_err(|e| format!("Failed reading file text: {e}"))?;
        Ok(content)
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    eprintln!("[{}] [END] read_text (success={})", current_timestamp(), res.is_ok());
    res
}

#[tauri::command]
async fn read_binary(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] read_binary path={path}");
    use base64::Engine;
    let root = {
        let guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .ok_or_else(|| "No workspace folder selected".to_string())?
            .clone()
    };

    let res = tauri::async_runtime::spawn_blocking(move || {
        let (mut file, _) = validate_and_open_read(&root, &path)?;
        let meta = file
            .metadata()
            .map_err(|e| format!("Metadata error: {e}"))?;
        if meta.len() > MAX_READ_BINARY_BYTES {
            return Err("Binary file size exceeds 50 MB limit".into());
        }

        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|e| format!("Failed reading binary bytes: {e}"))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    eprintln!("[{}] [END] read_binary (success={})", current_timestamp(), res.is_ok());
    res
}

#[tauri::command]
async fn write_text(
    path: String,
    content: String,
    expected_mtime: Option<u64>,
    force: Option<bool>,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] write_text path={path}");
    if content.len() as u64 > MAX_READ_TEXT_BYTES {
        return Err("Content exceeds 20 MB limit".into());
    }

    let root = {
        let guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .ok_or_else(|| "No workspace folder selected".to_string())?
            .clone()
    };

    let (parent_dir, target) = validate_write_target(&root, &path)?;

    if target.exists() && force != Some(true) {
        let m = expected_mtime
            .filter(|&m| m > 0)
            .ok_or_else(|| "Missing expected mtime".to_string())?;
        let disk_mtime = file_mtime(&target);
        if disk_mtime > m + 50 {
            return Err("Conflict: file changed on disk externally".into());
        }
    }

    // Stamp recent_writes BEFORE write/rename
    let now = Instant::now();
    {
        let mut rw = state
            .recent_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        rw.insert(target.clone(), now);
        let canon = canonicalize_path(&target);
        rw.insert(canon, now);
    }

    let temp_file_name = format!(
        ".tmp_{}_{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let temp_path = parent_dir.join(temp_file_name);

    let res = tauri::async_runtime::spawn_blocking(move || {
        let write_res = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temp_path)
                .map_err(|e| format!("Temporary write file creation failed: {e}"))?;

            file.write_all(content.as_bytes())
                .map_err(|e| format!("File write error: {e}"))?;
            file.sync_all()
                .map_err(|e| format!("File fsync error: {e}"))?;

            if let Ok(m) = fs::metadata(&target) {
                let _ = fs::set_permissions(&temp_path, m.permissions());
            }
            Ok(())
        })();

        if let Err(e) = write_res {
            let _ = fs::remove_file(&temp_path);
            return Err(e);
        }

        if let Err(e) = fs::rename(&temp_path, &target) {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("Atomic rename failed: {e}"));
        }

        let parent_file = File::open(&parent_dir)
            .map_err(|e| format!("Parent directory open for fsync failed: {e}"))?;
        parent_file
            .sync_all()
            .map_err(|e| format!("Parent directory fsync failed: {e}"))?;

        let mtime = file_mtime(&target);
        Ok((target, mtime))
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    match res {
        Ok((target, mtime)) => {
            let now_after = Instant::now();
            let mut rw = state
                .recent_writes
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            rw.insert(target.clone(), now_after);
            let canon = canonicalize_path(&target);
            rw.insert(canon, now_after);
            eprintln!("[{}] [END] write_text (success=true)", current_timestamp());
            Ok(mtime)
        }
        Err(e) => {
            eprintln!("[{}] [END] write_text (success=false)", current_timestamp());
            Err(e)
        }
    }
}

#[tauri::command]
async fn create_file(path: String, state: State<'_, AppState>) -> Result<u64, String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] create_file path={path}");
    let root = {
        let guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .ok_or_else(|| "No workspace folder selected".to_string())?
            .clone()
    };
    let (parent_dir, target) = validate_write_target(&root, &path)?;
    if target.exists() {
        return Err("File already exists".into());
    }

    let default_content = if path.ends_with(".canvas") {
        "{\"nodes\":[],\"edges\":[]}"
    } else {
        "# \n\n"
    };

    // Stamp recent_writes BEFORE create_new file write
    let now = Instant::now();
    {
        let mut rw = state
            .recent_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        rw.insert(target.clone(), now);
        let canon = canonicalize_path(&target);
        rw.insert(canon, now);
    }

    let target_clone = target.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&target_clone)
            .map_err(|e| format!("File creation failed: {e}"))?;

        file.write_all(default_content.as_bytes())
            .map_err(|e| format!("Initial write failed: {e}"))?;
        file.sync_all().map_err(|e| format!("Fsync failed: {e}"))?;

        let parent_file = File::open(&parent_dir)
            .map_err(|e| format!("Parent open failed: {e}"))?;
        parent_file
            .sync_all()
            .map_err(|e| format!("Parent fsync failed: {e}"))?;

        Ok(file_mtime(&target_clone))
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    match res {
        Ok(mtime) => {
            let now_after = Instant::now();
            let mut rw = state
                .recent_writes
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            rw.insert(target.clone(), now_after);
            let canon = canonicalize_path(&target);
            rw.insert(canon, now_after);
            eprintln!("[{}] [END] create_file (success=true)", current_timestamp());
            Ok(mtime)
        }
        Err(e) => {
            eprintln!("[{}] [END] create_file (success=false)", current_timestamp());
            Err(e)
        }
    }
}

#[tauri::command]
async fn create_dir(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] create_dir path={path}");
    let root = {
        let guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .ok_or_else(|| "No workspace folder selected".to_string())?
            .clone()
    };
    let target = root.join(Path::new(&path));
    for comp in Path::new(&path).components() {
        match comp {
            Component::ParentDir => return Err("Parent directory traversal rejected".into()),
            Component::Normal(s) => {
                if s.to_string_lossy().starts_with('.') {
                    return Err("Hidden path component rejected".into());
                }
            }
            _ => {}
        }
    }

    let res = tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&target).map_err(|e| format!("Directory creation failed: {e}"))
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    eprintln!("[{}] [END] create_dir (success={})", current_timestamp(), res.is_ok());
    res
}

#[tauri::command]
async fn rename(from: String, to: String, state: State<'_, AppState>) -> Result<(), String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] rename from={from} to={to}");
    let root = {
        let guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .ok_or_else(|| "No workspace folder selected".to_string())?
            .clone()
    };
    let (src_parent, src) = validate_write_target(&root, &from)?;
    let (dst_parent, dest) = validate_write_target(&root, &to)?;

    // Stamp recent_writes BEFORE hard_link & unlink
    let now = Instant::now();
    {
        let mut rw = state
            .recent_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        rw.insert(src.clone(), now);
        rw.insert(canonicalize_path(&src), now);
        rw.insert(dest.clone(), now);
        rw.insert(canonicalize_path(&dest), now);
    }

    let src_clone = src.clone();
    let dest_clone = dest.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        fs::hard_link(&src_clone, &dest_clone).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => "Destination already exists".to_string(),
            std::io::ErrorKind::NotFound => "Source file not found".to_string(),
            _ => format!("Rename failed: {e}"),
        })?;

        if let Err(e) = fs::remove_file(&src_clone) {
            let _ = fs::remove_file(&dest_clone);
            return Err(format!("Failed unlinking source: {e}"));
        }

        let p1 = File::open(&src_parent).map_err(|e| format!("Source parent open failed: {e}"))?;
        p1.sync_all()
            .map_err(|e| format!("Source parent fsync failed: {e}"))?;

        if src_parent != dst_parent {
            let p2 = File::open(&dst_parent).map_err(|e| format!("Dest parent open failed: {e}"))?;
            p2.sync_all()
                .map_err(|e| format!("Dest parent fsync failed: {e}"))?;
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    if res.is_ok() {
        let now_after = Instant::now();
        let mut rw = state
            .recent_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        rw.insert(src.clone(), now_after);
        rw.insert(canonicalize_path(&src), now_after);
        rw.insert(dest.clone(), now_after);
        rw.insert(canonicalize_path(&dest), now_after);
    }

    eprintln!("[{}] [END] rename (success={})", current_timestamp(), res.is_ok());
    res
}

#[tauri::command]
async fn trash(path: String, app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] trash path={path}");
    let root = {
        let guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .ok_or_else(|| "No workspace folder selected".to_string())?
            .clone()
    };

    let app_clone = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let (src_parent, target) = validate_write_target(&root, &path)?;

        let trash_path = root.join(TRASH_DIR);
        if trash_path.exists() {
            let meta = fs::symlink_metadata(&trash_path)
                .map_err(|e| format!("Failed reading trash metadata: {e}"))?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(".driftnote-trash is not a valid directory".into());
            }
        } else {
            fs::create_dir_all(&trash_path).map_err(|e| format!("Failed creating trash folder: {e}"))?;
        }

        let file_name = target
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "Invalid file name".to_string())?;

        let dest_filename = loop {
            let counter = TRASH_COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let candidate_name = format!("{nanos}_{counter}_{file_name}");
            let candidate = trash_path.join(&candidate_name);
            if !candidate.exists() {
                break candidate_name;
            }
        };
        let destination = trash_path.join(&dest_filename);

        // Stamp recent_writes BEFORE move to trash
        let now = Instant::now();
        {
            let st = app_clone.state::<AppState>();
            let mut rw = st.recent_writes.lock().unwrap_or_else(|e| e.into_inner());
            rw.insert(target.clone(), now);
            rw.insert(canonicalize_path(&target), now);
            rw.insert(destination.clone(), now);
            rw.insert(canonicalize_path(&destination), now);
        }

        fs::rename(&target, &destination).map_err(|e| format!("Move to trash failed: {e}"))?;

        let p = File::open(&src_parent).map_err(|e| format!("Parent open failed: {e}"))?;
        p.sync_all()
            .map_err(|e| format!("Parent fsync failed: {e}"))?;

        let tp = File::open(&trash_path).map_err(|e| format!("Trash dir open failed: {e}"))?;
        tp.sync_all()
            .map_err(|e| format!("Trash dir fsync failed: {e}"))?;

        let now_after = Instant::now();
        {
            let st = app_clone.state::<AppState>();
            let mut rw = st.recent_writes.lock().unwrap_or_else(|e| e.into_inner());
            rw.insert(target.clone(), now_after);
            rw.insert(canonicalize_path(&target), now_after);
            rw.insert(destination.clone(), now_after);
            rw.insert(canonicalize_path(&destination), now_after);
        }

        Ok(dest_filename)
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    match res {
        Ok(dest_name) => {
            eprintln!("[{}] [END] trash (success=true)", current_timestamp());
            Ok(dest_name)
        }
        Err(e) => {
            eprintln!("[{}] [END] trash (success=false)", current_timestamp());
            Err(e)
        }
    }
}

#[tauri::command]
async fn restore_from_trash(
    trash_name: String,
    original_path: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] restore_from_trash trash_name={trash_name}");
    let root = {
        let guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .ok_or_else(|| "No workspace folder selected".to_string())?
            .clone()
    };

    let trash_path_obj = Path::new(&trash_name);
    let mut components = trash_path_obj.components();
    let comp_name = match (components.next(), components.next()) {
        (Some(Component::Normal(c)), None) => c.to_string_lossy().to_string(),
        _ => return Err("trash_name must contain exactly one path component".into()),
    };

    let ext = trash_path_obj
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .ok_or_else(|| "Missing file extension in trash target".to_string())?;

    if !WRITE_EXTS.contains(&ext.as_str()) {
        return Err(format!("File extension .{ext} not permitted for restore"));
    }

    let rel_target = match original_path {
        Some(ref p) if !p.trim().is_empty() => p.clone(),
        _ => {
            let parts: Vec<&str> = comp_name.splitn(3, '_').collect();
            if parts.len() == 3 {
                parts[2].to_string()
            } else {
                comp_name.clone()
            }
        }
    };

    let app_clone = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let (dst_parent, dest_target) = validate_write_target(&root, &rel_target)?;

        let trash_dir_path = root.join(TRASH_DIR);
        let trash_meta = fs::symlink_metadata(&trash_dir_path)
            .map_err(|e| format!("Failed reading .driftnote-trash metadata: {e}"))?;
        if !trash_meta.is_dir() || trash_meta.file_type().is_symlink() {
            return Err(".driftnote-trash is not a directory or is a symlink".into());
        }
        let trash_dir_canon = trash_dir_path
            .canonicalize()
            .map_err(|e| format!("Canonicalizing trash dir failed: {e}"))?;

        let src_candidate = trash_dir_path.join(&comp_name);
        if !src_candidate.exists() {
            return Err("Trash file does not exist".into());
        }
        let src_meta = fs::symlink_metadata(&src_candidate)
            .map_err(|e| format!("Failed reading trash file metadata: {e}"))?;
        if !src_meta.file_type().is_file() || src_meta.file_type().is_symlink() {
            return Err("Target in trash is not a regular file".into());
        }
        let src_canon = src_candidate
            .canonicalize()
            .map_err(|e| format!("Failed canonicalizing trash source: {e}"))?;
        if !src_canon.starts_with(&trash_dir_canon) {
            return Err("Trash source escapes .driftnote-trash boundary".into());
        }

        if !dst_parent.exists() {
            return Err("Destination parent folder does not exist".into());
        }
        if dest_target.exists() {
            return Err("Destination file already exists".into());
        }

        let now = Instant::now();
        {
            let st = app_clone.state::<AppState>();
            let mut rw = st.recent_writes.lock().unwrap_or_else(|e| e.into_inner());
            rw.insert(dest_target.clone(), now);
            rw.insert(canonicalize_path(&dest_target), now);
            rw.insert(src_canon.clone(), now);
            rw.insert(canonicalize_path(&src_canon), now);
        }

        fs::hard_link(&src_canon, &dest_target).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => "Destination file already exists".to_string(),
            _ => format!("Restore hard_link failed: {e}"),
        })?;

        if let Err(e) = fs::remove_file(&src_canon) {
            let _ = fs::remove_file(&dest_target);
            return Err(format!("Failed unlinking trash source: {e}"));
        }

        let dp = File::open(&dst_parent).map_err(|e| format!("Dest parent open failed: {e}"))?;
        dp.sync_all()
            .map_err(|e| format!("Dest parent fsync failed: {e}"))?;

        let tp = File::open(&trash_dir_path).map_err(|e| format!("Trash dir open failed: {e}"))?;
        tp.sync_all()
            .map_err(|e| format!("Trash dir fsync failed: {e}"))?;

        let mtime = file_mtime(&dest_target);

        let now_after = Instant::now();
        {
            let st = app_clone.state::<AppState>();
            let mut rw = st.recent_writes.lock().unwrap_or_else(|e| e.into_inner());
            rw.insert(dest_target.clone(), now_after);
            rw.insert(canonicalize_path(&dest_target), now_after);
            rw.insert(src_canon.clone(), now_after);
        }

        Ok(mtime)
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    match res {
        Ok(mtime) => {
            eprintln!("[{}] [END] restore_from_trash (success=true)", current_timestamp());
            Ok(mtime)
        }
        Err(e) => {
            eprintln!("[{}] [END] restore_from_trash (success=false)", current_timestamp());
            Err(e)
        }
    }
}

fn start_watch_internal(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] start_watch_internal");
    let root = {
        let guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(r) => r.clone(),
            None => return Ok(()),
        }
    };

    let (tx, rx): (
        std::sync::mpsc::Sender<Result<Event, notify::Error>>,
        Receiver<Result<Event, notify::Error>>,
    ) = channel();
    let config = Config::default();
    let mut watcher = RecommendedWatcher::new(tx, config)
        .map_err(|e| format!("Failed initializing watcher: {e}"))?;

    let mut watch_dirs = Vec::new();
    let mut dir_queue = vec![root.clone()];
    let mut watch_capped = false;

    while let Some(current_dir) = dir_queue.pop() {
        if watch_dirs.len() >= MAX_WATCH_DIRS {
            watch_capped = true;
            eprintln!(
                "[{}] [WARN] Directory count exceeded MAX_WATCH_DIRS ({}). Watcher capped.",
                current_timestamp(),
                MAX_WATCH_DIRS
            );
            break;
        }
        watch_dirs.push(current_dir.clone());
        if let Ok(entries) = fs::read_dir(&current_dir) {
            for entry in entries.flatten() {
                if let Ok(ft) = entry.file_type() {
                    if ft.is_dir() && !ft.is_symlink() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if !name.starts_with('.') && name != TRASH_DIR {
                            dir_queue.push(entry.path());
                        }
                    }
                }
            }
        }
    }

    if watch_capped {
        for d in &watch_dirs {
            let _ = watcher.watch(d, RecursiveMode::NonRecursive);
        }
    } else {
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed watching directory: {e}"))?;
    }

    {
        let mut w_guard = state.watcher.lock().unwrap_or_else(|e| e.into_inner());
        *w_guard = Some(watcher);
    }

    let app_handle = app.clone();
    let root_clone = root.clone();

    std::thread::spawn(move || {
        let mut pending_paths = HashSet::new();

        loop {
            // Drop entries older than 2s
            {
                let state: State<AppState> = app_handle.state();
                let mut rw = state.recent_writes.lock().unwrap_or_else(|e| e.into_inner());
                rw.retain(|_, ts| ts.elapsed() < Duration::from_secs(2));
            }

            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(Ok(event)) => {
                    // Ignore read/access events
                    if matches!(event.kind, EventKind::Access(_)) {
                        continue;
                    }

                    let state: State<AppState> = app_handle.state();
                    let rw = state.recent_writes.lock().unwrap_or_else(|e| e.into_inner());
                    for p in event.paths {
                        if p.to_string_lossy().contains(TRASH_DIR) {
                            continue;
                        }
                        if p.file_name().map_or(false, |n| n.to_string_lossy().starts_with(".tmp_")) {
                            continue;
                        }
                        let has_dot_component = p.components().any(|c| match c {
                            Component::Normal(s) => s.to_string_lossy().starts_with('.'),
                            _ => false,
                        });
                        if has_dot_component {
                            continue;
                        }

                        let p_canon = p.canonicalize().unwrap_or_else(|_| p.clone());
                        let matched_ts = rw.get(&p).or_else(|| rw.get(&p_canon));

                        if let Some(ts) = matched_ts {
                            if ts.elapsed() < Duration::from_secs(2) {
                                eprintln!(
                                    "[{}] [WATCHER] suppressed own recent write: p='{}', p_canon='{}' (elapsed={:?})",
                                    current_timestamp(),
                                    p.display(),
                                    p_canon.display(),
                                    ts.elapsed()
                                );
                                continue;
                            }
                        }

                        eprintln!(
                            "[{}] [WATCHER] not suppressed: p='{}', p_canon='{}' (not in recent_writes or expired)",
                            current_timestamp(),
                            p.display(),
                            p_canon.display()
                        );

                        if let Ok(rel) = p.strip_prefix(&root_clone) {
                            pending_paths.insert(rel.to_string_lossy().to_string());
                        }
                    }
                }
                Ok(Err(_)) => {}
                Err(RecvTimeoutError::Timeout) => {
                    if !pending_paths.is_empty() {
                        let paths_vec: Vec<String> = pending_paths.drain().collect();
                        let _ = app_handle.emit("fs-changed", FsChangeEvent { paths: paths_vec });
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    eprintln!("[{}] [END] start_watch_internal (dirs={})", current_timestamp(), watch_dirs.len());
    Ok(())
}

#[tauri::command]
async fn start_watch(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    start_watch_internal(&app, &state)
}

#[tauri::command]
async fn stop_watch(state: State<'_, AppState>) -> Result<(), String> {
    let t0 = current_timestamp();
    eprintln!("[{t0}] [START] stop_watch");
    *state.watcher.lock().unwrap_or_else(|e| e.into_inner()) = None;
    eprintln!("[{}] [END] stop_watch", current_timestamp());
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("nav-guard")
                .on_navigation(|_webview, url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (url.scheme() == "http" && (
                            url.host_str() == Some("localhost")
                            || url.host_str() == Some("127.0.0.1")
                            || url.host_str() == Some("ipc.localhost")
                            || url.host_str() == Some("tauri.localhost")
                        ))
                })
                .build(),
        )
        .manage(AppState::default())
        .setup(|app| {
            let t0 = current_timestamp();
            eprintln!("[{t0}] [START] setup");
            let handle = app.handle();
            let state: State<AppState> = app.state();

            match load_persisted_root(handle) {
                Ok(Some(persisted)) => {
                    {
                        let mut guard = state.root_dir.lock().unwrap_or_else(|e| e.into_inner());
                        *guard = Some(persisted);
                    }
                    let _ = start_watch_internal(handle, &state);
                }
                Ok(None) => {}
                Err(err) => {
                    eprintln!("Workspace root error: {err}");
                }
            }
            eprintln!("[{}] [END] setup", current_timestamp());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_root,
            list_tree,
            read_text,
            read_binary,
            write_text,
            create_file,
            create_dir,
            rename,
            trash,
            restore_from_trash,
            start_watch,
            stop_watch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
