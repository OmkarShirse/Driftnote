# Driftnote

An offline-first, zero-network desktop notes application for Linux built with Tauri v2. Supports Markdown editing, reading views, and visual JSON Canvas 1.0 boards with atomic file operations and conflict detection.

## Key Features

- **Markdown & JSON Canvas 1.0**: Dual-mode support for Markdown notes and infinite visual canvas boards.
- **Offline & Zero-Network**: Zero external HTTP requests, telemetry, or remote dependencies.
- **Strict Content Security Policy**: CSP enforcement blocking external connections, form actions, and unauthorized scripts.
- **File System Safety**:
  - Sandboxed to the chosen workspace root folder.
  - Strict path traversal checks rejecting `..`, root escapes, and dot-files/hidden directories.
  - Read allowlist (`.md`, `.canvas`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`).
  - Write allowlist restricted strictly to `.md` and `.canvas`.
  - Atomic writes (`.tmp_*` creation, `fsync`, atomic `rename`, and parent directory `fsync`).
  - Soft delete to `.driftnote-trash` (no permanent unrecoverable deletes).
- **Conflict Handling**: Disk change detection via debounced file watcher (`notify`) with 3-way conflict dialog ("Keep mine", "Load disk version", "Save as copy").
- **Obsidian-Style Layout & Theming**: Clean sidebar navigation, reading/editing view toggles, document outline, and responsive Cozy Journal light/dark themes.

## Tech Stack

- **Desktop Framework**: [Tauri v2](https://v2.tauri.app/) (Rust backend, static webview frontend)
- **Frontend**: Plain HTML5, CSS3, JavaScript (no Node.js build step or bundler needed)
- **Libraries**:
  - [marked](https://github.com/markedjs/marked) (v12.0.2)
  - [DOMPurify](https://github.com/cure53/DOMPurify) (v3.1.6)
- **Rust Crates**: `tauri`, `tauri-plugin-dialog`, `notify`, `serde`, `serde_json`, `base64`, `libc`

## Building and Running

### Prerequisites

Ensure you have Rust and system dependencies installed:

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Install Tauri CLI:

```bash
cargo install tauri-cli --version "^2.0"
```

### Development

To check Rust backend code:

```bash
cd src-tauri
cargo check
```

### Build Desktop App

To build a release package (AppImage, deb):

```bash
cargo tauri build
```

