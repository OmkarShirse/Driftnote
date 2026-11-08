(async () => {
window.addEventListener('error', e => {
  const banner = document.getElementById('app-error-banner');
  const text = document.getElementById('app-error-text');
  if (banner && text) {
    text.textContent = `JS Error: ${e.message} (${e.filename}:${e.lineno})`;
    banner.hidden = false;
  }
});

window.addEventListener('unhandledrejection', e => {
  const banner = document.getElementById('app-error-banner');
  const text = document.getElementById('app-error-text');
  if (banner && text) {
    text.textContent = `Promise Rejection: ${e.reason?.message || e.reason}`;
    banner.hidden = false;
  }
});

/* ==========================================================================
   DRIFTNOTE APP - CORE LOGIC & REDESIGNED WORKSPACE
   ========================================================================== */

/* ==========================================================================
   HOTKEYS & KEYMAP ENGINE
   ========================================================================== */
const DEFAULT_KEYMAP = {
  'file:save': 'Ctrl+S',
  'file:new-note': 'Ctrl+N',
  'file:new-canvas': 'Ctrl+Shift+N',
  'file-explorer:move-file': 'Ctrl+M',
  'app:delete-file': '',
  'workspace:next-tab': 'Ctrl+PageDown',
  'workspace:previous-tab': 'Ctrl+PageUp',
  'workspace:close-tab': 'Ctrl+W',
  'app:command-palette': 'Ctrl+K',
  'app:toggle-view-mode': 'Ctrl+E',
  'app:toggle-theme': 'Ctrl+Shift+T',
  'app:toggle-left-sidebar': 'Ctrl+B',
  'app:toggle-right-sidebar': 'Ctrl+Shift+B',
  'app:switch-vault': 'F1',
  'app:reload': 'F5',
  'editor:toggle-highlight': 'F9',
  'app:open-shortcuts': 'Ctrl+/',
  'app:open-settings': 'Ctrl+,'
};

const ACTION_DESCRIPTIONS = {
  'file:save': 'Save active file',
  'file:new-note': 'New Markdown note',
  'file:new-canvas': 'New Canvas board',
  'file-explorer:move-file': 'Rename / move file',
  'app:delete-file': 'Delete current file (Trash)',
  'workspace:next-tab': 'Next open tab',
  'workspace:previous-tab': 'Previous open tab',
  'workspace:close-tab': 'Close active tab',
  'app:command-palette': 'Open command palette',
  'app:toggle-view-mode': 'Toggle Read / Edit mode',
  'app:toggle-theme': 'Toggle light / dark theme',
  'app:toggle-left-sidebar': 'Toggle left sidebar',
  'app:toggle-right-sidebar': 'Toggle right sidebar',
  'app:switch-vault': 'Open vault / folder',
  'app:reload': 'Reload workspace tree',
  'editor:toggle-highlight': 'Toggle highlight (==text==)',
  'app:open-shortcuts': 'Open keyboard shortcuts',
  'app:open-settings': 'Open settings'
};

let KEYMAP = { ...DEFAULT_KEYMAP };
try {
  const custom = JSON.parse(localStorage.getItem('dn_keys') || '{}');
  Object.assign(KEYMAP, custom);
} catch (_) {}

function saveKeymap() {
  localStorage.setItem('dn_keys', JSON.stringify(KEYMAP));
}

function resetKeymap() {
  KEYMAP = { ...DEFAULT_KEYMAP };
  localStorage.removeItem('dn_keys');
}

function normalizeKeyCombo(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');

  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (/^f\d{1,2}$/i.test(key)) key = key.toUpperCase();

  return mods.length ? `${mods.join('+')}+${key}` : key;
}

function findActionForKey(combo) {
  if (!combo) return null;
  const target = combo.toLowerCase();
  for (const [action, binding] of Object.entries(KEYMAP)) {
    if (binding && binding.toLowerCase() === target) {
      return action;
    }
  }
  return null;
}

function detectHotkeyConflicts() {
  const seen = new Map();
  const conflicts = [];
  for (const [act, key] of Object.entries(KEYMAP)) {
    if (!key) continue;
    const norm = key.toLowerCase();
    if (seen.has(norm)) {
      conflicts.push({ key, actions: [seen.get(norm), act] });
    } else {
      seen.set(norm, act);
    }
  }
  return conflicts;
}

/* ==========================================================================
   APP STATE & CONSTANTS
   ========================================================================== */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const B = document.body, R = document.documentElement;
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COL = { 1: 'var(--c-1)', 2: 'var(--c-2)', 3: 'var(--c-3)', 4: 'var(--c-4)', 5: 'var(--c-5)', 6: 'var(--c-6)' };
const uid = () => Math.random().toString(16).slice(2, 18);

const ed = $('#ed'), pvEl = $('#pv'), js = $('#js'), vp = $('#vp'), world = $('#world'), svg = $('#edges');
const treeEl = $('#file-tree'), badgeEl = $('#status-badge');
const cardToolbar = $('#card-toolbar');

let rootTree = null;
let fileMap = new Map();
let curPath = null;
let curFile = null;

let autosaveEnabled = true;
let autosaveTimer = null;
let autosavePendingFile = null;

let collapsedDirs = new Set();
let D = { nodes: [], edges: [] };
let sel = null, selE = null, V = { x: 60, y: 80, z: 1 }, drag = null;
let canvasBroken = false;
const nodeHtmlCache = new Map();

/* Moving state & rAF batching for canvas */
let movingTimer = null;
function markMoving() {
  vp.classList.add('moving');
  if (movingTimer) clearTimeout(movingTimer);
  movingTimer = setTimeout(() => {
    vp.classList.remove('moving');
    movingTimer = null;
  }, 120);
}

let viewRafId = null;
function requestViewUpdate() {
  if (viewRafId) return;
  viewRafId = requestAnimationFrame(() => {
    viewRafId = null;
    world.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.z})`;
    vp.style.backgroundSize = `${28 * V.z}px ${28 * V.z}px`;
    vp.style.backgroundPosition = `${V.x}px ${V.y}px`;
    if (V.z < 0.3) world.classList.add('lite');
    else world.classList.remove('lite');
    updateCardToolbar();
    updateCanvasStatusPill();
    renderMinimap();
  });
}

/* Image Viewer State */
let imgZoom = 1.0;
let imgPan = { x: 0, y: 0 };
let imgDragging = false;
let imgDragStart = { x: 0, y: 0, ox: 0, oy: 0 };

/* Drawer State (Pinned by default on desktop for Notion sidebar experience) */
let drawerPinned = localStorage.getItem('dn_drawer_pinned') !== 'false';
let drawerOpen = localStorage.getItem('dn_drawer_open') !== 'false';

function updateDrawerState() {
  $('#shell').classList.toggle('drawer-pinned', drawerPinned);
  $('#shell').classList.toggle('drawer-open', drawerOpen);
  const pinBtn = $('#btn-pin-drawer');
  if (pinBtn) pinBtn.setAttribute('aria-pressed', String(drawerPinned));
  const railFiles = $('#rail-files');
  if (railFiles) railFiles.classList.toggle('active', drawerOpen);

  const backdrop = $('#drawer-backdrop');
  if (backdrop) {
    if (window.innerWidth <= 760 && drawerOpen && !drawerPinned) {
      backdrop.hidden = false;
    } else {
      backdrop.hidden = true;
    }
  }
}
window.addEventListener('resize', updateDrawerState);

function toggleDrawer(forceState) {
  drawerOpen = (typeof forceState === 'boolean') ? forceState : !drawerOpen;
  localStorage.setItem('dn_drawer_open', String(drawerOpen));
  updateDrawerState();
}

function togglePinDrawer() {
  drawerPinned = !drawerPinned;
  localStorage.setItem('dn_drawer_pinned', String(drawerPinned));
  if (drawerPinned) drawerOpen = true;
  updateDrawerState();
}

/* Right Sidebar State (Outline & Info, open by default on > 900px screens) */
let rightSidebarOpen = localStorage.getItem('dn_right_sidebar_open') !== null
  ? localStorage.getItem('dn_right_sidebar_open') === 'true'
  : (window.innerWidth > 900);

function updateRightSidebarState() {
  $('#shell').classList.toggle('right-sidebar-open', rightSidebarOpen);
  const btn = $('#btn-toggle-right-sidebar');
  if (btn) btn.setAttribute('aria-pressed', String(rightSidebarOpen));
}
window.addEventListener('resize', updateRightSidebarState);

function toggleRightSidebar(forceState) {
  rightSidebarOpen = (typeof forceState === 'boolean') ? forceState : !rightSidebarOpen;
  localStorage.setItem('dn_right_sidebar_open', String(rightSidebarOpen));
  updateRightSidebarState();
  if (rightSidebarOpen) {
    updateOutline();
    updateLiveInfo();
  }
}

/* Tabs State */
let openTabs = [];
try {
  const savedTabs = JSON.parse(localStorage.getItem('dn_tabs') || '[]');
  if (Array.isArray(savedTabs)) openTabs = savedTabs;
} catch (_) {}

function saveTabsState() {
  localStorage.setItem('dn_tabs', JSON.stringify(openTabs.map(t => ({ path: t.path, name: t.name, type: t.type }))));
}

function renderTabs() {
  const container = $('#tabs-list');
  container.innerHTML = '';
  openTabs.forEach(tab => {
    const pill = document.createElement('div');
    pill.className = `tab-pill${tab.path === curPath ? ' active' : ''}${tab.dirty ? ' dirty' : ''}`;
    pill.dataset.path = tab.path;

    let icon = '📄';
    if (tab.type === 'cv') icon = '◫';
    else if (tab.type === 'img') icon = '🖼️';

    pill.innerHTML = `<span class="tab-icon">${icon}</span>` +
      `<span class="tab-title">${esc(tab.name)}</span>` +
      `<span class="tab-dot" title="Unsaved changes"></span>` +
      `<button class="tab-close" title="Close (Middle-click)" aria-label="Close tab">✕</button>`;

    pill.onclick = e => {
      if (e.target.closest('.tab-close')) return;
      openFile(tab.path);
    };

    pill.onauxclick = e => {
      if (e.button === 1) { // Middle click close
        e.preventDefault();
        closeTab(tab.path);
      }
    };

    pill.querySelector('.tab-close').onclick = e => {
      e.stopPropagation();
      closeTab(tab.path);
    };

    container.appendChild(pill);
  });
}

async function addTab(file) {
  let existing = openTabs.find(t => t.path === file.path);
  if (!existing) {
    existing = { path: file.path, name: file.name, type: file.type, dirty: !!file.dirty };
    openTabs.push(existing);
  } else {
    existing.name = file.name;
    existing.dirty = !!file.dirty;
  }
  saveTabsState();
  renderTabs();
}

function showWelcomeStage(show) {
  const ws = $('#welcome-stage');
  const nh = $('#note-header');
  const mdStage = $('#md');
  if (ws) ws.hidden = !show;
  if (nh) nh.hidden = show;
  if (mdStage) mdStage.hidden = show;
}

async function closeTab(path, skipSave = false) {
  const target = fileMap.get(path);
  if (!skipSave && target && target.dirty) {
    const res = await saveFile(target, false);
    if (!res.ok) {
      toast('Cannot close tab: saving changes failed');
      return;
    }
  }
  const idx = openTabs.findIndex(t => t.path === path);
  if (idx !== -1) {
    openTabs.splice(idx, 1);
    saveTabsState();
    renderTabs();
    if (curPath === path) {
      if (openTabs.length) {
        const nextIdx = Math.min(idx, openTabs.length - 1);
        await openFile(openTabs[nextIdx].path);
      } else {
        curFile = curPath = null;
        $('#note-title').textContent = 'No file open';
        ed.value = '';
        pvEl.innerHTML = '';
        B.dataset.type = 'md';
        updateStatusPill();
        showWelcomeStage(true);
      }
    }
  }
}

/* Theme handling */
const savedTheme = localStorage.getItem('dn_theme') || 'light';
R.dataset.theme = savedTheme;
let dark = (savedTheme === 'dark');

function applyTheme(isDark) {
  dark = isDark;
  const theme = dark ? 'dark' : 'light';
  R.dataset.theme = theme;
  localStorage.setItem('dn_theme', theme);
  const themeBtn = $('#btn-theme');
  if (themeBtn) {
    const icon = themeBtn.querySelector('.btn-icon');
    if (icon) icon.textContent = dark ? '🌙' : '☀️';
  }
  if (B.dataset.type === 'cv' || (curFile && curFile.type === 'cv')) {
    nodeHtmlCache.clear();
    draw();
  }
  renderMinimap();
}
applyTheme(dark);
$('#btn-theme').onclick = () => applyTheme(!dark);

/* ==========================================================================
   STRICT HTML SANITIZATION (RULE 8)
   ========================================================================== */
function clean(html) {
  if (typeof DOMPurify !== 'undefined' && DOMPurify.sanitize) {
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: ['form', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'svg', 'math'],
      FORBID_ATTR: ['style'],
      ADD_TAGS: ['input', 'mark'],
      ADD_ATTR: ['checked', 'disabled', 'type', 'data-note', 'data-h', 'data-src']
    });
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,style,link,meta,form,svg,math').forEach(e => e.remove());
  doc.body.querySelectorAll('*').forEach(e => {
    e.removeAttribute('style');
    [...e.attributes].forEach(a => {
      if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) e.removeAttribute(a.name);
    });
  });
  return doc.body.innerHTML;
}

if (typeof marked !== 'undefined') {
  marked.use({
    extensions: [{
      name: 'hl',
      level: 'inline',
      start(src) { return src.indexOf('=='); },
      tokenizer(src) {
        const m = /^==(?!=)([^=\n]+?)==/.exec(src);
        if (m) return { type: 'hl', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer(tok) { return '<mark>' + this.parser.parseInline(tok.tokens) + '</mark>'; }
    }]
  });
}

function toggleHighlight() {
  if (document.activeElement !== ed) return;
  const s = ed.selectionStart, t = ed.selectionEnd, v = ed.value;
  ed.value = v.slice(0, s) + '==' + v.slice(s, t) + '==' + v.slice(t);
  ed.setSelectionRange(s + 2, t + 2);
  ed.dispatchEvent(new Event('input'));
}

/* ==========================================================================
   IMAGE RESOLUTION & MIME TYPES
   ========================================================================== */
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const imageCache = new Map();

function getMimeType(ext) {
  const m = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml'
  };
  return m[ext ? ext.toLowerCase() : ''] || 'application/octet-stream';
}

function resolveVaultImage(target, noteDir) {
  if (!target) return null;
  const cleanTarget = target.split('|')[0].trim();
  if (noteDir) {
    const rel = `${noteDir}/${cleanTarget}`;
    if (fileMap.has(rel)) return rel;
  }
  if (fileMap.has(cleanTarget)) return cleanTarget;

  const targetBase = cleanTarget.split('/').pop().toLowerCase();
  let best = null;
  for (const [path, f] of fileMap.entries()) {
    if (f.name.toLowerCase() === targetBase) {
      if (!best || path.length < best.length) best = path;
    }
  }
  return best;
}

async function resolvePreviewImages(containerEl, currentNotePath) {
  const noteDir = currentNotePath && currentNotePath.includes('/') ? currentNotePath.slice(0, currentNotePath.lastIndexOf('/')) : '';
  const imgs = containerEl.querySelectorAll('img');

  for (const img of imgs) {
    const src = img.getAttribute('src') || '';
    if (/^https?:\/\//i.test(src)) {
      img.remove();
      continue;
    }
    if (src.startsWith('data:')) continue;

    const resolvedPath = resolveVaultImage(src, noteDir);
    if (!resolvedPath) {
      const placeholder = document.createElement('span');
      placeholder.className = 'img-missing-badge';
      placeholder.textContent = `Image not found: ${src}`;
      img.replaceWith(placeholder);
      continue;
    }

    let dataUrl = imageCache.get(resolvedPath);
    if (!dataUrl) {
      try {
        const b64 = await storage.readBinary(resolvedPath);
        if (b64) {
          const ext = resolvedPath.split('.').pop();
          dataUrl = `data:${getMimeType(ext)};base64,${b64}`;
          if (imageCache.size >= 50) {
            const firstKey = imageCache.keys().next().value;
            imageCache.delete(firstKey);
          }
          imageCache.set(resolvedPath, dataUrl);
        }
      } catch (err) {
        dataUrl = null;
      }
    }

    if (dataUrl) {
      img.src = dataUrl;
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'img-missing-badge';
      placeholder.textContent = `Image not found: ${src}`;
      img.replaceWith(placeholder);
    }
  }
}

/* ==========================================================================
   STORAGE ADAPTER & ERROR DISPLAY
   ========================================================================== */
function showErrorBanner(msg) {
  const b = $('#app-error-banner');
  const t = $('#app-error-text');
  if (b && t) {
    t.textContent = msg;
    b.hidden = false;
  }
  toast(msg);
}

function hideErrorBanner() {
  const b = $('#app-error-banner');
  if (b) b.hidden = true;
}

const btnCloseErr = $('#btn-close-error-banner');
if (btnCloseErr) btnCloseErr.onclick = hideErrorBanner;

const isTauri = typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
let storage = null;

if (isTauri && (!window.__TAURI__ || !window.__TAURI__.core)) {
  const b = $('#tauri-missing-banner');
  if (b) b.hidden = false;
  showErrorBanner('Tauri environment detected but window.__TAURI__.core is missing.');
}

if (isTauri && window.__TAURI__ && window.__TAURI__.core) {
  const core = window.__TAURI__.core;
  async function invokeTauri(cmd, args) {
    const start = performance.now();
    console.log(`[IPC] [START] ${cmd}`, args !== undefined ? args : '');

    let timeoutFired = false;
    const watchdogTimer = setTimeout(() => {
      timeoutFired = true;
      showErrorBanner(`[WATCHDOG 3s] IPC command [${cmd}] is still pending or blocked!`);
    }, 3000);

    try {
      const res = await core.invoke(cmd, args);
      clearTimeout(watchdogTimer);
      const duration = (performance.now() - start).toFixed(1);
      console.log(`[IPC] [END] ${cmd} (${duration}ms)`);
      if (timeoutFired) {
        hideErrorBanner();
      }
      return res;
    } catch (err) {
      clearTimeout(watchdogTimer);
      const duration = (performance.now() - start).toFixed(1);
      console.error(`[IPC] [ERROR] ${cmd} (${duration}ms):`, err);
      if (cmd !== 'list_tree' || !String(err).includes('No workspace folder selected')) {
        showErrorBanner(`IPC [${cmd}] failed (${duration}ms): ${err}`);
      }
      throw err;
    }
  }

  storage = {
    async pickRoot() { return await invokeTauri('pick_root'); },
    async listTree() { return await invokeTauri('list_tree'); },
    async readText(path) { return await invokeTauri('read_text', { path }); },
    async readBinary(path) { return await invokeTauri('read_binary', { path }); },
    async writeText(path, content, expectedMtime, force) {
      return await invokeTauri('write_text', { path, content, expectedMtime, force });
    },
    async createFile(path) { return await invokeTauri('create_file', { path }); },
    async createDir(path) { return await invokeTauri('create_dir', { path }); },
    async rename(from, to) { return await invokeTauri('rename', { from, to }); },
    async trash(path) { return await invokeTauri('trash', { path }); },
    async restoreFromTrash(trashName, originalPath) {
      return await invokeTauri('restore_from_trash', { trashName, originalPath });
    },
    async startWatch() { return await invokeTauri('start_watch'); },
    async stopWatch() { return await invokeTauri('stop_watch'); },
    async watch(cb) {
      if (window.__TAURI__.event) {
        return await window.__TAURI__.event.listen('fs-changed', (event) => cb(event.payload));
      }
    }
  };
} else {
  const demoBanner = $('#demo-mode-banner');
  if (demoBanner) demoBanner.hidden = false;

  class BrowserBackend {
    constructor() {
      this.key = 'driftnote_browser_vault_v2';
      this.data = JSON.parse(localStorage.getItem(this.key) || '{}');
      if (!this.data['Welcome.md']) {
        this.data['Welcome.md'] = {
          content: '# Welcome to Driftnote\n\n- Cozy Journal Theme active\n- Fast full-width editing\n- Press `Ctrl+K` for command palette\n- Press `F9` for ==highlighting==\n',
          mtime: Date.now()
        };
        this.save();
      }
    }
    save() { localStorage.setItem(this.key, JSON.stringify(this.data)); }
    async pickRoot() { return 'Demo Workspace'; }
    async listTree() {
      const root = { name: 'Demo Workspace', path: '', kind: 'directory', children: [] };
      for (const [p, val] of Object.entries(this.data)) {
        root.children.push({ name: p, path: p, kind: 'file', mtime: val.mtime });
      }
      return root;
    }
    async readText(path) {
      if (this.data[path]) return this.data[path].content;
      throw new Error('File not found: ' + path);
    }
    async readBinary() { return ''; }
    async writeText(path, content, expectedMtime, force) {
      const cur = this.data[path];
      if (cur && !force && expectedMtime !== null && cur.mtime !== expectedMtime) {
        throw new Error('Conflict: modified externally');
      }
      const newM = Date.now();
      this.data[path] = { content, mtime: newM };
      this.save();
      return newM;
    }
    async createFile(path) {
      const m = Date.now();
      this.data[path] = { content: '', mtime: m };
      this.save();
      return m;
    }
    async createDir() {}
    async rename(from, to) {
      if (this.data[from]) {
        this.data[to] = this.data[from];
        delete this.data[from];
        this.save();
      }
    }
    async trash(path) {
      const item = this.data[path];
      delete this.data[path];
      if (!this.trashStore) this.trashStore = {};
      const trashName = `${Date.now()}_0_${path.split('/').pop()}`;
      this.trashStore[trashName] = { content: item ? item.content : '', path };
      this.save();
      return trashName;
    }
    async restoreFromTrash(trashName, originalPath) {
      if (!this.trashStore || !this.trashStore[trashName]) {
        throw new Error('Trash item not found');
      }
      const item = this.trashStore[trashName];
      const target = originalPath || item.path;
      const m = Date.now();
      this.data[target] = { content: item.content, mtime: m };
      delete this.trashStore[trashName];
      this.save();
      return m;
    }
    async startWatch() {}
    async stopWatch() {}
    async watch() { return () => {}; }
  }
  storage = new BrowserBackend();
}

/* ==========================================================================
   STATUS PILL, METADATA & BADGE HANDLING
   ========================================================================== */
function setSaveBadge(state) {
  badgeEl.className = 'status-badge ' + state;
  if (state === 'saved') badgeEl.textContent = 'Saved';
  else if (state === 'saving') badgeEl.textContent = 'Saving…';
  else if (state === 'unsaved') badgeEl.textContent = 'Unsaved';
  else if (state === 'conflict') badgeEl.textContent = 'Conflict';
  else if (state === 'error') badgeEl.textContent = 'Error';
}

function updateStatusPill() {
  const isCanvas = B.dataset.type === 'cv';
  $('#status-pill-note').style.display = isCanvas ? 'none' : 'flex';
  $('#status-pill-canvas').style.display = isCanvas ? 'flex' : 'none';

  if (!isCanvas) {
    const text = (curFile && curFile.content) || ed.value || '';
    const words = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
    $('#pill-words').textContent = `${words} words`;
  }
}

function updateCanvasStatusPill() {
  $('#pill-canvas-zoom').textContent = `${Math.round(V.z * 100)}%`;
}

function updateLiveInfo(text) {
  if (!curFile) return;
  if (curFile.type === 'md') {
    const val = typeof text === 'string' ? text : ((curFile && curFile.content) || (ed && ed.value) || '');
    const chars = val.length;
    const words = val.trim() ? val.trim().split(/\s+/).filter(Boolean).length : 0;
    const readingTime = Math.max(1, Math.ceil(words / 200)) + ' min read';

    const wordsEl = $('#info-words');
    if (wordsEl) wordsEl.textContent = `${words} words`;
    const charsEl = $('#info-chars');
    if (charsEl) charsEl.textContent = `${chars} chars`;
    const readEl = $('#info-reading-time');
    if (readEl) readEl.textContent = readingTime;
    const mtimeEl = $('#info-mtime');
    if (mtimeEl) {
      if (curFile.mtime) {
        const d = new Date(curFile.mtime);
        mtimeEl.textContent = isNaN(d.getTime()) ? 'Recently' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else {
        mtimeEl.textContent = 'Just now';
      }
    }
    const noteInfo = $('#info-details-note');
    const cvInfo = $('#info-details-canvas');
    if (noteInfo) noteInfo.style.display = 'flex';
    if (cvInfo) cvInfo.style.display = 'none';
  } else if (curFile.type === 'cv') {
    const noteInfo = $('#info-details-note');
    const cvInfo = $('#info-details-canvas');
    if (noteInfo) noteInfo.style.display = 'none';
    if (cvInfo) cvInfo.style.display = 'flex';

    const cardsEl = $('#info-canvas-cards');
    if (cardsEl) cardsEl.textContent = String(D && D.nodes ? D.nodes.length : 0);
    const linksEl = $('#info-canvas-links');
    if (linksEl) linksEl.textContent = String(D && D.edges ? D.edges.length : 0);
    const zoomEl = $('#info-canvas-zoom');
    if (zoomEl) zoomEl.textContent = `${Math.round(V.z * 100)}%`;
  }
}

let liveInfoThrottleTimer = null;
let lastLiveInfoCall = 0;

function throttledUpdateLiveInfo(text) {
  const now = Date.now();
  const elapsed = now - lastLiveInfoCall;
  if (elapsed >= 200) {
    if (liveInfoThrottleTimer) {
      clearTimeout(liveInfoThrottleTimer);
      liveInfoThrottleTimer = null;
    }
    lastLiveInfoCall = now;
    updateLiveInfo(text);
  } else if (!liveInfoThrottleTimer) {
    liveInfoThrottleTimer = setTimeout(() => {
      lastLiveInfoCall = Date.now();
      liveInfoThrottleTimer = null;
      updateLiveInfo(text);
    }, 200 - elapsed);
  }
}

function updateNoteMetaChips() {
  if (!curFile) {
    $('#note-title').textContent = 'No file open';
    return;
  }
  $('#note-title').textContent = curFile.name.replace(/\.(md|canvas)$/, '');
}

/* ==========================================================================
   MARKDOWN PREVIEW & OUTLINE
   ========================================================================== */
function renderMarkdown(text) {
  try {
    if (typeof marked !== 'undefined') {
      let processed = text.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => {
        return `<img src="${esc(a.trim())}" alt="${esc(b ? b.trim() : a.trim())}" data-src="${esc(a.trim())}">`;
      });
      processed = processed.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => {
        return `<a href="#" data-note="${esc(a.trim())}">${esc(b ? b.trim() : a.trim())}</a>`;
      });
      return clean(marked.parse(processed));
    }
  } catch (_) {}
  return '<pre>' + esc(text) + '</pre>';
}

async function updatePreview() {
  if (!curFile || curFile.type !== 'md') return;
  pvEl.innerHTML = renderMarkdown(ed.value);
  if (curPath) {
    await resolvePreviewImages(pvEl, curPath);
  }
  updateOutline();
  updateStatusPill();
  updateNoteMetaChips();
  updateLiveInfo();
}

function highlightCurrentHeading() {
  const list = $('#outline-list');
  if (!list || !curFile || curFile.type !== 'md') return;
  const items = list.querySelectorAll('.outline-item');
  if (!items.length) return;

  if (B.dataset.mode === 'read') {
    const headings = pvEl.querySelectorAll('h1,h2,h3,h4,h5,h6');
    if (!headings.length) return;
    const docContainer = $('#doc-container');
    const containerTop = docContainer ? docContainer.getBoundingClientRect().top : 0;
    let activeIdx = 0;
    headings.forEach((h, idx) => {
      const relTop = h.getBoundingClientRect().top - containerTop;
      if (relTop <= 60) activeIdx = idx;
    });
    items.forEach((item, idx) => {
      item.classList.toggle('active', idx === activeIdx);
    });
  } else {
    const cursorPos = ed.selectionStart || 0;
    let activeIdx = 0;
    items.forEach((item, idx) => {
      const pos = parseInt(item.dataset.index, 10);
      if (!isNaN(pos) && pos <= cursorPos) activeIdx = idx;
    });
    items.forEach((item, idx) => {
      item.classList.toggle('active', idx === activeIdx);
    });
  }
}

let outlineRaf = null;
function onDocContainerScroll() {
  if (outlineRaf !== null) return;
  outlineRaf = requestAnimationFrame(() => {
    outlineRaf = null;
    highlightCurrentHeading();
  });
}

const docContainerEl = $('#doc-container');
if (docContainerEl) docContainerEl.addEventListener('scroll', onDocContainerScroll);
ed.addEventListener('keyup', highlightCurrentHeading);
ed.addEventListener('click', highlightCurrentHeading);

function updateOutline() {
  const list = $('#outline-list');
  if (!list) return;
  if (!curFile || curFile.type !== 'md') {
    list.innerHTML = '<span class="mute">No outline available</span>';
    return;
  }
  const content = (curFile && curFile.content) || ed.value || '';
  const hs = [...content.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  if (!hs.length) {
    list.innerHTML = '<span class="mute" style="padding:4px">No headings found</span>';
    return;
  }
  list.innerHTML = hs.map((m, i) => {
    const pad = (m[1].length - 1) * 10;
    return `<a href="#" class="outline-item" data-h="${i}" data-index="${m.index}" style="padding-left:${pad + 6}px">${esc(m[2])}</a>`;
  }).join('');
  highlightCurrentHeading();
}

const outlineListContainer = $('#outline-list');
if (outlineListContainer) {
  outlineListContainer.onclick = e => {
    const a = e.target.closest('[data-h]');
    if (!a) return;
    e.preventDefault();
    outlineListContainer.querySelectorAll('.outline-item').forEach(el => el.classList.remove('active'));
    a.classList.add('active');

    const hIdx = parseInt(a.dataset.h, 10);
    if (B.dataset.mode === 'read') {
      const headings = pvEl.querySelectorAll('h1,h2,h3,h4,h5,h6');
      const targetH = headings[hIdx];
      if (targetH) targetH.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      const charIndex = parseInt(a.dataset.index, 10);
      if (!isNaN(charIndex)) {
        ed.focus();
        ed.setSelectionRange(charIndex, charIndex);
        const linesBefore = (ed.value.slice(0, charIndex).match(/\n/g) || []).length;
        ed.scrollTop = linesBefore * 20;
      }
    }
  };
}

/* View Mode Toggle */
function setViewMode(mode) {
  B.dataset.mode = mode;
  const btn = $('#btn-view-mode');
  if (btn) btn.textContent = mode === 'read' ? '✏️ Edit' : '📖 Read';
  if (mode === 'read') updatePreview();
  else ed.focus();
}

$('#btn-view-mode').onclick = () => {
  setViewMode(B.dataset.mode === 'read' ? 'edit' : 'read');
};

/* ==========================================================================
   FILE SAVING & CONFLICT RESOLUTION
   ========================================================================== */
const inFlightSaves = new Map();
const savePendingRerun = new Set();

function queueSave(file = curFile) {
  if (!file || !autosaveEnabled || canvasBroken) return;
  file.dirty = true;
  if (!curFile || curFile.path === file.path) {
    setSaveBadge('unsaved');
  }
  const openT = openTabs.find(t => t.path === file.path);
  if (openT) openT.dirty = true;
  renderTabs();

  autosavePendingFile = file;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    if (autosavePendingFile && autosavePendingFile.dirty) {
      await saveFile(autosavePendingFile, false);
    }
  }, 1000);
}

async function saveFile(fileToSave, force = false) {
  if (!fileToSave || canvasBroken) {
    return { ok: false, error: 'Invalid file or corrupted canvas' };
  }
  if (!fileToSave.dirty) {
    return { ok: true, mtime: fileToSave.mtime };
  }
  if (!force && fileToSave.mtime === undefined) {
    toast('Error: File mtime unknown. Refusing save.');
    return { ok: false, error: 'File mtime unknown' };
  }

  if (inFlightSaves.has(fileToSave.path)) {
    savePendingRerun.add(fileToSave.path);
    const inFlightResult = await inFlightSaves.get(fileToSave.path);
    if (!inFlightResult || !inFlightResult.ok) {
      return inFlightResult || { ok: false, error: 'In-flight save failed' };
    }
    if (!fileToSave.dirty) {
      return inFlightResult;
    }
    return await saveFile(fileToSave, force);
  }

  savePendingRerun.delete(fileToSave.path);

  let resolveSavePromise;
  const currentPromise = new Promise(res => { resolveSavePromise = res; });
  inFlightSaves.set(fileToSave.path, currentPromise);

  const contentToWrite = fileToSave.content;
  setSaveBadge('saving');

  try {
    const newMtime = await storage.writeText(
      fileToSave.path,
      contentToWrite,
      fileToSave.mtime,
      force
    );
    fileToSave.mtime = newMtime;

    if (fileToSave.content === contentToWrite) {
      fileToSave.dirty = false;
      const openT = openTabs.find(t => t.path === fileToSave.path);
      if (openT) openT.dirty = false;
      renderTabs();

      if (curFile && curFile.path === fileToSave.path) {
        setSaveBadge('saved');
      }
    } else {
      fileToSave.dirty = true;
      queueSave(fileToSave);
    }

    const result = { ok: true, mtime: newMtime };
    resolveSavePromise(result);
    inFlightSaves.delete(fileToSave.path);

    if (savePendingRerun.has(fileToSave.path) && fileToSave.dirty) {
      savePendingRerun.delete(fileToSave.path);
      saveFile(fileToSave, force);
    }
    return result;
  } catch (err) {
    const errMsg = String(err);
    const isConflict = errMsg.includes('Conflict');
    if (isConflict) {
      setSaveBadge('conflict');
    } else {
      setSaveBadge('error');
      toast('Save failed: ' + errMsg);
    }
    const result = { ok: false, error: errMsg };
    resolveSavePromise(result);
    inFlightSaves.delete(fileToSave.path);
    if (isConflict) {
      await showConflictDialog(fileToSave.path);
      if (!fileToSave.dirty) {
        return { ok: true, mtime: fileToSave.mtime };
      }
    }
    return result;
  }
}

async function saveActiveFile() {
  if (!curFile) return { ok: false, error: 'No active file' };
  if (curFile.type === 'md') curFile.content = ed.value;
  else if (curFile.type === 'cv' && !canvasBroken) curFile.content = js.value;
  curFile.dirty = true;
  return await saveFile(curFile, false);
}

async function showConflictDialog(path) {
  const f = fileMap.get(path);
  if (!f) return;
  const choice = await showModal({
    title: 'File Conflict Detected',
    desc: `"${f.name}" was modified externally on disk.\nWhat would you like to do?`,
    buttons: [
      { label: 'Keep Mine (Overwrite disk)', value: 'keep_mine', primary: true },
      { label: 'Load Disk (Discard changes)', value: 'load_disk' },
      { label: 'Save Copy', value: 'save_copy' }
    ]
  });

  if (choice === 'keep_mine') {
    const res = await saveFile(f, true);
    if (!res.ok) return;
  } else if (choice === 'load_disk') {
    f.content = await storage.readText(path);
    await reloadTree();
    const fresh = fileMap.get(path);
    if (fresh) f.mtime = fresh.mtime;
    f.dirty = false;
    if (curFile && curFile.path === path) {
      if (f.type === 'md') { ed.value = f.content; await updatePreview(); }
      else if (f.type === 'cv') { loadCanvas(); draw(); }
      setSaveBadge('saved');
    }
  } else if (choice === 'save_copy') {
    const copyPath = path.replace(/(\.[^.]+)$/, '-copy$1');
    await storage.createFile(copyPath);
    await storage.writeText(copyPath, f.content, null, true);
    await reloadTree();
    toast(`Saved copy to ${copyPath}`);
  }
}

/* ==========================================================================
   IMAGE VIEWER ENGINE
   ========================================================================== */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function updateImgTransform() {
  const imgEl = $('#img-viewed');
  if (imgEl) {
    imgEl.style.transform = `translate(${imgPan.x}px, ${imgPan.y}px) scale(${imgZoom})`;
  }
}

function updateImgMeta() {
  if (!curFile) return;
  const sizeText = curFile.size ? ` — ${formatBytes(curFile.size)}` : '';
  $('#img-meta').textContent = `${curFile.name}${sizeText} (${Math.round(imgZoom * 100)}%)`;
}

async function openImageViewer(path) {
  const f = fileMap.get(path);
  if (!f) return;

  if (curFile && curFile.dirty) {
    const res = await saveFile(curFile, false);
    if (!res.ok) {
      toast('Cannot open image: saving active file failed');
      return;
    }
  }

  curPath = path;
  curFile = f;
  sel = selE = null;
  B.dataset.type = 'img';
  addTab(f);

  const imgEl = $('#img-viewed');
  let dataUrl = imageCache.get(path);

  if (!dataUrl) {
    try {
      const b64 = await storage.readBinary(path);
      const ext = path.split('.').pop().toLowerCase();
      dataUrl = `data:${getMimeType(ext)};base64,${b64}`;
      f.size = Math.round((b64.length * 3) / 4);
      imageCache.set(path, dataUrl);
    } catch (err) {
      imgEl.removeAttribute('src');
      $('#img-meta').textContent = `${f.name} — Error loading image`;
      toast('Failed loading image: ' + err);
      return;
    }
  }

  imgEl.src = dataUrl;
  imgZoom = 1.0;
  imgPan = { x: 0, y: 0 };
  updateImgTransform();
  updateImgMeta();

  treeEl.querySelectorAll('.file-row').forEach(r => r.classList.toggle('active', r.dataset.p === curPath));
  setSaveBadge('saved');
}

const imgCanvas = $('#img-canvas');
imgCanvas.onpointerdown = e => {
  if (B.dataset.type !== 'img') return;
  imgDragging = true;
  imgDragStart = { x: e.clientX, y: e.clientY, ox: imgPan.x, oy: imgPan.y };
  try { imgCanvas.setPointerCapture(e.pointerId); } catch (_) {}
};
imgCanvas.onpointermove = e => {
  if (!imgDragging) return;
  imgPan.x = imgDragStart.ox + (e.clientX - imgDragStart.x);
  imgPan.y = imgDragStart.oy + (e.clientY - imgDragStart.y);
  updateImgTransform();
};
imgCanvas.onpointerup = imgCanvas.onpointercancel = e => {
  imgDragging = false;
  try { imgCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
};
imgCanvas.ondblclick = () => {
  if (B.dataset.type !== 'img') return;
  imgZoom = 1.0;
  imgPan = { x: 0, y: 0 };
  updateImgTransform();
  updateImgMeta();
};
imgCanvas.addEventListener('wheel', e => {
  if (B.dataset.type !== 'img') return;
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  imgZoom = Math.min(10.0, Math.max(0.05, imgZoom * factor));
  updateImgTransform();
  updateImgMeta();
}, { passive: false });

$('#btn-img-fit').onclick = () => {
  imgZoom = 1.0;
  imgPan = { x: 0, y: 0 };
  updateImgTransform();
  updateImgMeta();
};
$('#btn-img-100').onclick = () => {
  imgZoom = 1.0;
  imgPan = { x: 0, y: 0 };
  updateImgTransform();
  updateImgMeta();
};
$('#btn-img-zin').onclick = () => {
  imgZoom = Math.min(10.0, imgZoom * 1.25);
  updateImgTransform();
  updateImgMeta();
};
$('#btn-img-zout').onclick = () => {
  imgZoom = Math.max(0.05, imgZoom / 1.25);
  updateImgTransform();
  updateImgMeta();
};

/* ==========================================================================
   FILE OPENING & TREE RENDERING
   ========================================================================== */
async function openFile(path) {
  const f = fileMap.get(path);
  if (!f) return;

  if (curFile && curFile.dirty && curFile.path !== path) {
    const res = await saveFile(curFile, false);
    if (!res.ok) {
      toast('Cannot switch note: saving active file failed');
      return;
    }
  }

  if (f.type === 'img') {
    return await openImageViewer(path);
  }

  if (f.content === null) {
    f.content = await storage.readText(path);
  }

  curPath = path;
  curFile = f;
  sel = selE = null;
  B.dataset.type = f.type;
  showWelcomeStage(false);
  addTab(f);

  const pageIcon = $('#note-page-icon');
  if (pageIcon) {
    pageIcon.textContent = (f.type === 'cv') ? '◫' : (f.type === 'img') ? '🖼️' : '📄';
  }

  if (f.type === 'md') {
    ed.value = f.content || '';
    setViewMode(B.dataset.mode || 'read');
    await updatePreview();
  } else if (f.type === 'cv') {
    js.value = f.content || '{"nodes":[],"edges":[]}';
    loadCanvas();
    draw();
    V = { x: 60, y: 80, z: 1 };
    view();
    renderMinimap();
  }

  treeEl.querySelectorAll('.file-row').forEach(r => r.classList.toggle('active', r.dataset.p === curPath));
  setSaveBadge(f.dirty ? 'unsaved' : 'saved');
  updateStatusPill();
  updateNoteMetaChips();
  updateLiveInfo();
  updateOutline();
}

let isReloadingTree = false;
let reloadTreeDirty = false;

async function reloadTree() {
  if (isReloadingTree) {
    reloadTreeDirty = true;
    return;
  }
  isReloadingTree = true;
  try {
    const tree = await storage.listTree();
    rootTree = tree;
    const newMap = new Map();

    function walk(node) {
      if (node.kind === 'file') {
        const ext = node.name.split('.').pop().toLowerCase();
        let type = 'other';
        if (ext === 'md') type = 'md';
        else if (ext === 'canvas') type = 'cv';
        else if (IMG_EXTS.includes(ext)) type = 'img';

        const prev = fileMap.get(node.path);
        newMap.set(node.path, {
          path: node.path,
          name: node.name,
          type,
          mtime: node.mtime,
          content: prev ? prev.content : null,
          dirty: prev ? prev.dirty : false,
          size: prev ? prev.size : 0
        });
      }
      if (node.children) node.children.forEach(walk);
    }
    walk(tree);
    fileMap = newMap;
    renderTree();
    renderTabs();
  } catch (err) {
    rootTree = null;
    renderTree();
    throw err;
  } finally {
    isReloadingTree = false;
    if (reloadTreeDirty) {
      reloadTreeDirty = false;
      reloadTree();
    }
  }
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('dn_settings') || '{}');
  } catch (e) {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem('dn_settings', JSON.stringify(settings));
}

let appSettings = loadSettings();
let allowRenameTrash = !!appSettings.allowRenameTrash;

function isPathGuarded(path) {
  if (!path || path === '.' || path === '/') return true;
  const parts = path.split('/');
  return parts.some(p => p.startsWith('.') || p === '.driftnote-trash');
}

function isValidNoteExtension(path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  return ext === 'md' || ext === 'canvas';
}

let activeRowMenu = null;

function closeRowMenu() {
  if (activeRowMenu) {
    activeRowMenu.remove();
    activeRowMenu = null;
  }
}

document.addEventListener('click', e => {
  if (activeRowMenu && !activeRowMenu.contains(e.target)) closeRowMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && activeRowMenu) closeRowMenu();
});

function openRowMenu(anchorEl, path, isDir) {
  closeRowMenu();
  const menu = document.createElement('div');
  menu.className = 'row-popover-menu';

  if (isDir) {
    const actions = [
      { label: 'New note here', fn: () => promptCreateFile('md', path) },
      { label: 'New canvas here', fn: () => promptCreateFile('canvas', path) },
      { label: 'New folder here', fn: () => promptCreateFolder(path) }
    ];
    actions.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'menu-item';
      btn.textContent = item.label;
      btn.onclick = (e) => { e.stopPropagation(); closeRowMenu(); item.fn(); };
      menu.appendChild(btn);
    });
  } else {
    if (!allowRenameTrash || isPathGuarded(path) || !isValidNoteExtension(path)) return;
    const renameBtn = document.createElement('button');
    renameBtn.className = 'menu-item';
    renameBtn.textContent = 'Rename';
    renameBtn.onclick = (e) => { e.stopPropagation(); closeRowMenu(); promptRename(path); };
    menu.appendChild(renameBtn);

    const div = document.createElement('div');
    div.className = 'menu-divider';
    menu.appendChild(div);

    const trashBtn = document.createElement('button');
    trashBtn.className = 'menu-item danger';
    trashBtn.textContent = 'Move to trash';
    trashBtn.onclick = (e) => { e.stopPropagation(); closeRowMenu(); promptDelete(path); };
    menu.appendChild(trashBtn);
  }

  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(10, rect.right - 150)}px`;
  activeRowMenu = menu;
}

function renderTree() {
  treeEl.innerHTML = '';
  if (!rootTree || !rootTree.children || rootTree.children.length === 0) {
    const emptyPrompt = document.createElement('div');
    emptyPrompt.className = 'tree-empty-prompt';
    emptyPrompt.innerHTML = `
      <div class="tree-empty-icon">📂</div>
      <div class="tree-empty-text">${!rootTree ? 'No workspace folder selected' : 'Workspace folder is empty'}</div>
      <button id="btn-tree-open" class="btn-tree-open">Choose Folder</button>
    `;
    const openBtn = emptyPrompt.querySelector('#btn-tree-open');
    if (openBtn) openBtn.onclick = () => $('#btn-open-dir').click();
    treeEl.appendChild(emptyPrompt);
    return;
  }

  function buildBranch(node) {
    if (node.kind === 'directory') {
      const isRoot = !node.path;
      const wrap = document.createElement('div');
      wrap.className = 'tree-dir';

      if (!isRoot) {
        const isCollapsed = collapsedDirs.has(node.path);
        const row = document.createElement('div');
        row.className = 'tree-row dir-row';
        row.dataset.d = node.path;
        row.innerHTML =
          `<span class="chevron">${isCollapsed ? '▶' : '▼'}</span>` +
          `<span class="icon">📁</span>` +
          `<span class="title">${esc(node.name)}</span>` +
          `<button class="row-more-btn" title="Actions" aria-label="Directory actions" data-action="more">⋯</button>`;
        wrap.appendChild(row);

        const sub = document.createElement('div');
        sub.className = 'tree-sub' + (isCollapsed ? ' collapsed' : '');
        if (node.children) {
          node.children
            .sort((a, b) => (b.kind === 'directory') - (a.kind === 'directory') || a.name.localeCompare(b.name))
            .forEach(c => sub.appendChild(buildBranch(c)));
        }
        wrap.appendChild(sub);
      } else {
        if (node.children) {
          node.children
            .sort((a, b) => (b.kind === 'directory') - (a.kind === 'directory') || a.name.localeCompare(b.name))
            .forEach(c => wrap.appendChild(buildBranch(c)));
        }
      }
      return wrap;
    } else {
      const row = document.createElement('div');
      const isAct = node.path === curPath;
      row.className = 'tree-row file-row' + (isAct ? ' active' : '');
      row.dataset.p = node.path;

      const ext = node.name.split('.').pop().toLowerCase();
      let icon = '📄';
      if (ext === 'canvas') icon = '◫';
      else if (IMG_EXTS.includes(ext)) icon = '🖼️';

      const showMoreBtn = allowRenameTrash && !isPathGuarded(node.path) && isValidNoteExtension(node.path);

      row.innerHTML =
        `  <span class="chevron" style="opacity:0">•</span>` +
        `  <span class="icon">${icon}</span>` +
        `  <span class="title">${esc(node.name)}</span>` +
        (showMoreBtn ? `  <button class="row-more-btn" title="Actions" aria-label="File actions" data-action="more">⋯</button>` : '');
      return row;
    }
  }

  treeEl.appendChild(buildBranch(rootTree));
}

/* ==========================================================================
   CANVAS CORE & PSEUDO-ELEMENT SHAPES
   ========================================================================== */
let canvasFormat = { indent: '\t', lineEnding: '\n', hasTrailingNewline: true, compactColons: false };

function compactColons(s) {
  return s.replace(/"(?:[^"\\]|\\.)*"|: /g, m => m === ': ' ? ':' : m);
}

function detectCanvasFormat(text) {
  if (!text) return { indent: '\t', lineEnding: '\n', hasTrailingNewline: true, compactColons: false };
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = text.endsWith('\n');
  const indentMatch = text.match(/\n([ \t]+)"/);
  const indent = indentMatch ? indentMatch[1] : '\t';
  const colonMatch = text.match(/"(?:[^"\\]|\\.)*"\s*:/);
  const isCompactColons = colonMatch ? !text.slice(colonMatch.index + colonMatch[0].length).startsWith(' ') : false;
  return { indent, lineEnding, hasTrailingNewline, compactColons: isCompactColons };
}

function serializeCanvasData(data, format = canvasFormat) {
  let serialized = JSON.stringify(data, null, format.indent || '\t');
  if (format.compactColons) {
    serialized = compactColons(serialized);
  }
  if (format.lineEnding === '\r\n') {
    serialized = serialized.replace(/\r?\n/g, '\r\n');
  }
  if (format.hasTrailingNewline && !serialized.endsWith(format.lineEnding)) {
    serialized += format.lineEnding;
  }
  return serialized;
}

function loadCanvas() {
  canvasBroken = false;
  const banner = $('#canvas-broken-banner');
  if (banner) banner.hidden = true;

  try {
    const rawText = curFile && curFile.content ? curFile.content : (js.value || '{"nodes":[],"edges":[]}');
    canvasFormat = detectCanvasFormat(rawText);
    D = JSON.parse(rawText);
    if (!D || typeof D !== 'object' || !Array.isArray(D.nodes) || !Array.isArray(D.edges)) {
      throw new Error('Invalid schema');
    }
  } catch (e) {
    canvasBroken = true;
    if (banner) banner.hidden = false;
    D = { nodes: [], edges: [] };
    toast('Canvas corrupted. Overwrite prevented.');
    return;
  }
}

function commitCanvas() {
  if (!curFile || canvasBroken) return;
  const newContent = serializeCanvasData(D, canvasFormat);
  if (newContent === curFile.content) return;
  curFile.content = newContent;
  js.value = curFile.content;
  queueSave();
  renderMinimap();
  throttledUpdateLiveInfo();
}

const DX = { left: -1, right: 1, top: 0, bottom: 0 }, DY = { top: -1, bottom: 1, left: 0, right: 0 };
const anc = (n, s) => ({
  top: [n.x + n.width / 2, n.y],
  bottom: [n.x + n.width / 2, n.y + n.height],
  left: [n.x, n.y + n.height / 2],
  right: [n.x + n.width, n.y + n.height / 2]
})[s];

function sides(a, b, e) {
  if (e.fromSide && e.toSide) return [e.fromSide, e.toSide];
  const dx = b.x + b.width / 2 - a.x - a.width / 2, dy = b.y + b.height / 2 - a.y - a.height / 2;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ['right', 'left'] : ['left', 'right']) : (dy > 0 ? ['bottom', 'top'] : ['top', 'bottom']);
}

function edges(previewPath) {
  let svgEl = document.getElementById('edges');
  if (!svgEl) { svgEl = document.createElementNS('http://www.w3.org/2000/svg','svg'); svgEl.id = 'edges'; world.prepend(svgEl); }
  svgEl.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;color:var(--mute);z-index:0';
  svgEl.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>' +
    D.edges.map(e => {
      const a = D.nodes.find(n => n.id === e.fromNode), b = D.nodes.find(n => n.id === e.toNode);
      if (!a || !b) return '';
      const [fs, ts] = sides(a, b, e), p = anc(a, fs), q = anc(b, ts);
      if (!p || !q) return '';
      const d = 'M' + p[0] + ' ' + p[1] + 'C' + (p[0] + DX[fs] * 80) + ' ' + (p[1] + DY[fs] * 80) + ' ' + (q[0] + DX[ts] * 80) + ' ' + (q[1] + DY[ts] * 80) + ' ' + q[0] + ' ' + q[1];

      const sa = e.styleAttributes || {};
      const isDashed = typeof sa.path === 'string' && sa.path.toLowerCase().includes('dashed');
      const edgeClass = 'v' + (e.id === selE ? ' sel' : '') + (isDashed ? ' dashed' : '');

      let labelHtml = '';
      if (e.label) {
        const mx = (p[0] + q[0]) / 2;
        const my = (p[1] + q[1]) / 2;
        labelHtml = `<text class="edge-label-text" x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="central">${esc(e.label)}</text>`;
      }

      return '<path class="h" data-id="' + esc(e.id) + '" d="' + d + '"/>' +
             '<path class="' + edgeClass + '" d="' + d + '"' + (e.toEnd === 'none' ? '' : ' marker-end="url(#ah)"') + '/>' +
             labelHtml;
    }).join('') + (previewPath ? '<path class="dr" d="' + previewPath + '"/>' : '');
}

async function renderNodeBodyContent(n, containerEl) {
  const cacheKey = `${n.id}:${n.type}:${n.text || n.label || n.file || n.url || ''}`;
  if (nodeHtmlCache.has(cacheKey)) {
    containerEl.innerHTML = nodeHtmlCache.get(cacheKey);
    return;
  }
  if (n.type === 'text') {
    containerEl.innerHTML = renderMarkdown(n.text || '');
    if (curPath) await resolvePreviewImages(containerEl, curPath);
    nodeHtmlCache.set(cacheKey, containerEl.innerHTML);
  } else if (n.type === 'group') {
    containerEl.textContent = n.label || '';
    nodeHtmlCache.set(cacheKey, containerEl.innerHTML);
  } else if (n.type === 'file') {
    const rawFile = n.file || '';
    const ext = rawFile.split('.').pop().toLowerCase();
    if (IMG_EXTS.includes(ext)) {
      const noteDir = curPath && curPath.includes('/') ? curPath.slice(0, curPath.lastIndexOf('/')) : '';
      const resolved = resolveVaultImage(rawFile, noteDir);
      if (resolved) {
        let dataUrl = imageCache.get(resolved);
        if (!dataUrl) {
          try {
            const b64 = await storage.readBinary(resolved);
            if (b64) {
              dataUrl = `data:${getMimeType(ext)};base64,${b64}`;
              imageCache.set(resolved, dataUrl);
            }
          } catch (_) {}
        }
        if (dataUrl) {
          containerEl.innerHTML = `<img src="${dataUrl}" alt="${esc(rawFile)}" style="width:100%;height:100%;object-fit:contain;border-radius:4px">`;
          nodeHtmlCache.set(cacheKey, containerEl.innerHTML);
          return;
        }
      }
      containerEl.innerHTML = `<strong>🖼️ ${esc(rawFile)}</strong><br><span class="mute">Image not loaded</span>`;
      nodeHtmlCache.set(cacheKey, containerEl.innerHTML);
    } else {
      containerEl.innerHTML = `<strong>📄 ${esc(rawFile)}</strong>`;
      nodeHtmlCache.set(cacheKey, containerEl.innerHTML);
    }
  } else if (n.type === 'link') {
    containerEl.innerHTML = `<span class="mute">🔗</span> <a href="#" class="canvas-link" data-url="${esc(n.url || '')}">${esc(n.url || '')}</a>`;
    nodeHtmlCache.set(cacheKey, containerEl.innerHTML);
  }
}

function place(n, el) {
  Object.assign(el.style, {
    left: n.x + 'px',
    top: n.y + 'px',
    width: n.width + 'px',
    height: n.height + 'px'
  });
}

function draw() {
  world.querySelectorAll('.node').forEach(e => e.remove());
  D.nodes.forEach(n => {
    const el = document.createElement('div');
    el.className = 'node ' + n.type + (n.id === sel ? ' sel' : '');
    el.dataset.id = n.id;
    place(n, el);

    const sa = n.styleAttributes || {};
    el.dataset.shape = sa.shape || 'default';
    el.dataset.border = sa.border || 'solid';

    const textAlign = sa.textAlign || n.textAlign;
    if (textAlign) {
      el.dataset.align = textAlign.toLowerCase();
    }

    const bw = Math.max(1, Math.min(6, Number(sa.borderWidth || n.borderWidth) || 2));
    el.style.setProperty('--node-border-width', bw + 'px');

    const c = n.color ? (COL[n.color] || n.color) : '';
    if (c) {
      el.style.setProperty('--node-color', c);
      el.style.setProperty('--node-border-color', c);
      el.dataset.colored = 'true';
    }

    el.innerHTML =
      `<div class="body"></div>` +
      '<i class="hd"></i><i class="rz"></i>';

    world.appendChild(el);
    renderNodeBodyContent(n, el.querySelector('.body'));
  });
  edges();
  updateCardToolbar();
}

function view() {
  requestViewUpdate();
}

const toW = (cx, cy) => {
  const r = vp.getBoundingClientRect();
  return [(cx - r.left - V.x) / V.z, (cy - r.top - V.y) / V.z];
};

function zoomAt(mx, my, factor) {
  const z = Math.min(4.0, Math.max(0.02, V.z * factor));
  if (z === V.z) return;
  V.x = mx - (mx - V.x) * z / V.z;
  V.y = my - (my - V.y) * z / V.z;
  V.z = z;
  requestViewUpdate();
  throttledUpdateLiveInfo();
}

function editNode(el) {
  if (canvasBroken) return;
  const n = D.nodes.find(x => x.id === el.dataset.id);
  if (!n || !['text', 'group'].includes(n.type)) return;
  const k = n.type === 'group' ? 'label' : 'text';
  const b = el.querySelector('.body');
  const t = document.createElement('textarea');
  t.value = n[k] || '';
  t.style.width = '100%';
  t.style.height = '100%';
  t.style.border = 'none';
  t.style.background = 'transparent';
  t.style.color = 'inherit';
  t.style.font = 'inherit';
  t.style.resize = 'none';
  t.style.outline = 'none';

  b.replaceWith(t);
  t.focus();
  t.onblur = () => {
    n[k] = t.value;
    commitCanvas();
    nodeHtmlCache.clear();
    draw();
  };
  t.onkeydown = e => {
    if (e.key === 'Escape') t.blur();
    e.stopPropagation();
  };
}

function addNode(x, y, type) {
  if (canvasBroken) return;
  const n = {
    id: uid(),
    type,
    x: Math.round(x),
    y: Math.round(y),
    width: type === 'group' ? 420 : 240,
    height: type === 'group' ? 300 : 100,
    styleAttributes: { shape: 'default', border: 'solid', borderWidth: 2 }
  };
  if (type === 'text') n.text = '';
  else n.label = 'Group';

  D.nodes.push(n);
  sel = n.id;
  commitCanvas();
  nodeHtmlCache.clear();
  draw();
  throttledUpdateLiveInfo();
  const el = world.querySelector('[data-id="' + n.id + '"]');
  if (el) editNode(el);
}

function mid(w, h) {
  const r = vp.getBoundingClientRect(), p = toW(r.left + r.width / 2, r.top + r.height / 2);
  return [p[0] - w / 2, p[1] - h / 2];
}

/* Floating Card Toolbar */
function updateCardToolbar() {
  if (!cardToolbar) return;
  if (!sel || B.dataset.type !== 'cv' || B.dataset.canvasView === 'json' || canvasBroken) {
    cardToolbar.hidden = true;
    return;
  }
  const n = D.nodes.find(x => x.id === sel);
  if (!n || n.type === 'group') {
    cardToolbar.hidden = true;
    return;
  }

  const el = world.querySelector(`[data-id="${sel}"]`);
  if (!el) { cardToolbar.hidden = true; return; }

  const screenX = V.x + (n.x + n.width / 2) * V.z;
  const screenY = V.y + n.y * V.z;

  cardToolbar.style.left = screenX + 'px';
  cardToolbar.style.top = screenY + 'px';

  const sa = n.styleAttributes || {};
  const tbShape = $('#tb-shape');
  if (tbShape) {
    const shapeVal = sa.shape || 'default';
    let opt = Array.from(tbShape.options).find(o => o.value === shapeVal);
    if (!opt && shapeVal) {
      opt = document.createElement('option');
      opt.value = shapeVal;
      opt.textContent = shapeVal.charAt(0).toUpperCase() + shapeVal.slice(1);
      tbShape.appendChild(opt);
    }
    tbShape.value = shapeVal;
  }
  $('#tb-border').value = sa.border || 'solid';
  $('#tb-width').value = sa.borderWidth || n.borderWidth || 2;
  const tbAlign = $('#tb-align');
  if (tbAlign) {
    tbAlign.value = sa.textAlign || n.textAlign || 'left';
  }

  const curColor = n.color ? String(n.color) : '';
  cardToolbar.querySelectorAll('.tb-swatch').forEach(b => {
    b.classList.toggle('on', (b.dataset.c || '') === curColor);
  });
  const customColorInput = $('#tb-custom-color');
  if (customColorInput && curColor.startsWith('#')) {
    customColorInput.value = curColor;
  }

  cardToolbar.hidden = false;
}

const tbColors = cardToolbar ? cardToolbar.querySelector('.tb-colors') : null;
if (tbColors) {
  tbColors.onclick = e => {
    const btn = e.target.closest('[data-c]');
    if (!btn || !sel) return;
    const n = D.nodes.find(x => x.id === sel);
    if (!n) return;
    if (btn.dataset.c) n.color = btn.dataset.c;
    else delete n.color;
    commitCanvas();
    draw();
  };
}

const customColorInput = $('#tb-custom-color');
if (customColorInput) {
  customColorInput.oninput = e => {
    if (!sel) return;
    const n = D.nodes.find(x => x.id === sel);
    if (!n) return;
    n.color = e.target.value;
    commitCanvas();
    draw();
  };
}

$('#tb-shape').onchange = e => {
  if (!sel) return;
  const n = D.nodes.find(x => x.id === sel);
  if (!n) return;
  if (!n.styleAttributes) n.styleAttributes = {};
  n.styleAttributes.shape = e.target.value;
  commitCanvas();
  draw();
};

$('#tb-border').onchange = e => {
  if (!sel) return;
  const n = D.nodes.find(x => x.id === sel);
  if (!n) return;
  if (!n.styleAttributes) n.styleAttributes = {};
  n.styleAttributes.border = e.target.value;
  commitCanvas();
  draw();
};

const tbAlignInput = $('#tb-align');
if (tbAlignInput) {
  tbAlignInput.onchange = e => {
    if (!sel) return;
    const n = D.nodes.find(x => x.id === sel);
    if (!n) return;
    if (!n.styleAttributes) n.styleAttributes = {};
    n.styleAttributes.textAlign = e.target.value;
    commitCanvas();
    draw();
  };
}

$('#tb-width').oninput = e => {
  if (!sel) return;
  const n = D.nodes.find(x => x.id === sel);
  if (!n) return;
  if (!n.styleAttributes) n.styleAttributes = {};
  n.styleAttributes.borderWidth = Number(e.target.value);
  commitCanvas();
  draw();
};

$('#tb-del').onclick = () => {
  if (!sel) return;
  D.nodes = D.nodes.filter(n => n.id !== sel);
  D.edges = D.edges.filter(x => x.fromNode !== sel && x.toNode !== sel);
  sel = null;
  commitCanvas();
  draw();
  throttledUpdateLiveInfo();
};

/* Canvas Minimap Renderer */
function renderMinimap() {
  const canvas = $('#minimap-canvas');
  if (!canvas || B.dataset.type !== 'cv' || canvasBroken) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!D.nodes.length) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  D.nodes.forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  });

  const vpRect = vp.getBoundingClientRect();
  const [vLeft, vTop] = toW(vpRect.left, vpRect.top);
  const [vRight, vBottom] = toW(vpRect.right, vpRect.bottom);

  minX = Math.min(minX, vLeft) - 80;
  minY = Math.min(minY, vTop) - 80;
  maxX = Math.max(maxX, vRight) + 80;
  maxY = Math.max(maxY, vBottom) + 80;

  const totalW = maxX - minX || 1;
  const totalH = maxY - minY || 1;
  const scale = Math.min(w / totalW, h / totalH);
  const offX = (w - totalW * scale) / 2;
  const offY = (h - totalH * scale) / 2;

  // Draw node boxes
  ctx.fillStyle = dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.18)';
  D.nodes.forEach(n => {
    const rx = offX + (n.x - minX) * scale;
    const ry = offY + (n.y - minY) * scale;
    const rw = Math.max(2, n.width * scale);
    const rh = Math.max(2, n.height * scale);
    ctx.fillRect(rx, ry, rw, rh);
  });

  // Draw viewport frame
  ctx.strokeStyle = dark ? '#81a8f8' : '#3366cc';
  ctx.lineWidth = 1.5;
  const vx = offX + (vLeft - minX) * scale;
  const vy = offY + (vTop - minY) * scale;
  const vw = (vRight - vLeft) * scale;
  const vh = (vBottom - vTop) * scale;
  ctx.strokeRect(vx, vy, vw, vh);
}

/* Canvas Pointer & Wheel Listeners */
vp.onpointerdown = e => {
  if (e.target.closest('textarea, select, input, button, #card-toolbar')) return;
  const el = e.target.closest('.node');
  const n = el && D.nodes.find(x => x.id === el.dataset.id);
  const hp = e.target.closest('path.h');

  sel = n ? n.id : null;
  selE = hp ? hp.dataset.id : null;

  world.querySelectorAll('.node').forEach(x => x.classList.toggle('sel', x.dataset.id === sel));
  edges();
  updateCardToolbar();

  const b = { x: e.clientX, y: e.clientY };
  if (n && e.target.closest('.hd')) drag = { k: 'link', n };
  else if (n && e.target.closest('.rz')) drag = { k: 'rz', n, el, w: n.width, h: n.height, ...b };
  else if (n) drag = { k: 'mv', n, el, ox: n.x, oy: n.y, ...b };
  else drag = { k: 'pan', ox: V.x, oy: V.y, ...b };

  try { vp.setPointerCapture(e.pointerId); } catch (_) {}
};

vp.onpointermove = e => {
  if (!drag) return;
  markMoving();
  const dx = e.clientX - (drag.x || 0), dy = e.clientY - (drag.y || 0);

  if (drag.k === 'pan') {
    V.x = drag.ox + dx;
    V.y = drag.oy + dy;
    requestViewUpdate();
  } else if (drag.k === 'mv') {
    drag.n.x = Math.round(drag.ox + dx / V.z);
    drag.n.y = Math.round(drag.oy + dy / V.z);
    place(drag.n, drag.el);
    edges();
    updateCardToolbar();
  } else if (drag.k === 'rz') {
    drag.n.width = Math.max(80, Math.round(drag.w + dx / V.z));
    drag.n.height = Math.max(50, Math.round(drag.h + dy / V.z));
    place(drag.n, drag.el);
    edges();
    updateCardToolbar();
  } else if (drag.k === 'link') {
    const w = toW(e.clientX, e.clientY);
    const p = anc(drag.n, 'right');
    edges('M' + p[0] + ' ' + p[1] + 'L' + w[0] + ' ' + w[1]);
  }
};

vp.onpointerup = e => {
  if (!drag) return;
  const d = drag;
  drag = null;

  if (d.k === 'link') {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const el = t && t.closest('.node');
    if (el && el.dataset.id !== d.n.id) {
      D.edges.push({ id: uid(), fromNode: d.n.id, toNode: el.dataset.id });
      commitCanvas();
    }
    edges();
  } else if (d.k !== 'pan') {
    commitCanvas();
  }
  updateCardToolbar();
};

vp.addEventListener('wheel', e => {
  if (B.dataset.type !== 'cv') return;
  e.preventDefault();
  markMoving();
  const r = vp.getBoundingClientRect();
  const factor = Math.exp(-e.deltaY * 0.0015);
  zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
}, { passive: false });

vp.ondblclick = e => {
  if (canvasBroken) return;
  const el = e.target.closest('.node');
  if (el) return editNode(el);
  if (e.target.closest('path, #card-toolbar, .ctl, .canvas-top-bar, #canvas-minimap')) return;
  const p = toW(e.clientX, e.clientY);
  addNode(p[0] - 120, p[1] - 50, 'text');
};

$('#ac').onclick = () => { const p = mid(240, 100); addNode(p[0], p[1], 'text'); };
$('#ag').onclick = () => { const p = mid(420, 300); addNode(p[0], p[1], 'group'); };
$('#zi').onclick = () => { const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); };
$('#zo').onclick = () => { const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.25); };
$('#zr').onclick = () => { V = { x: 60, y: 80, z: 1 }; requestViewUpdate(); throttledUpdateLiveInfo(); };

$('#pill-zin').onclick = () => { const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); };
$('#pill-zout').onclick = () => { const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.25); };
$('#pill-zr').onclick = () => { V = { x: 60, y: 80, z: 1 }; requestViewUpdate(); throttledUpdateLiveInfo(); };

$('#btn-canvas-view').onclick = () => {
  const current = B.dataset.canvasView;
  B.dataset.canvasView = current === 'json' ? 'board' : 'json';
  $('#btn-canvas-view').textContent = current === 'json' ? 'JSON' : 'Board';
  if (B.dataset.canvasView === 'board') {
    loadCanvas();
    draw();
  }
};

/* ==========================================================================
   COMMAND PALETTE MODAL
   ========================================================================== */
let paletteIndex = 0;
let paletteItems = [];

function openCommandPalette() {
  const modal = $('#palette-modal');
  const input = $('#palette-input');
  modal.hidden = false;
  input.value = '';
  input.focus();
  renderPaletteResults('');
}

function closeCommandPalette() {
  $('#palette-modal').hidden = true;
}

function getPaletteActions() {
  const baseActions = [
    { id: 'file:new-note', title: 'New Markdown Note', icon: '📄', cat: 'File' },
    { id: 'file:new-canvas', title: 'New Canvas Board', icon: '◫', cat: 'File' },
    { id: 'file:new-folder', title: 'New Folder', icon: '📁', cat: 'File' },
    { id: 'app:switch-vault', title: 'Open / Switch Folder', icon: '📂', cat: 'Vault' },
    { id: 'app:toggle-view-mode', title: 'Toggle Read / Edit Mode', icon: '✏️', cat: 'Editor' },
    { id: 'editor:toggle-highlight', title: 'Toggle Highlight (==text==)', icon: '🖍️', cat: 'Editor' },
    { id: 'app:toggle-theme', title: 'Toggle Light / Dark Theme', icon: '☀️', cat: 'View' },
    { id: 'app:toggle-left-sidebar', title: 'Toggle File Drawer', icon: '📑', cat: 'View' },
    { id: 'app:open-shortcuts', title: 'Keyboard Shortcuts', icon: '⌨️', cat: 'Help' },
    { id: 'app:open-settings', title: 'Open settings', icon: '', cat: 'Settings' },
    { id: 'app:reload', title: 'Reload Workspace Tree', icon: '🔄', cat: 'Vault' }
  ];

  const fileActions = Array.from(fileMap.values()).map(f => ({
    id: `jump:${f.path}`,
    title: f.name,
    icon: f.type === 'cv' ? '◫' : f.type === 'img' ? '🖼️' : '📄',
    cat: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : 'Root',
    path: f.path
  }));

  return [...baseActions, ...fileActions];
}

function renderPaletteResults(query) {
  const q = query.trim().toLowerCase();
  const all = getPaletteActions();
  paletteItems = all.filter(item => {
    return !q || item.title.toLowerCase().includes(q) || item.cat.toLowerCase().includes(q);
  }).slice(0, 30);

  paletteIndex = 0;
  const container = $('#palette-results');
  container.innerHTML = '';

  if (!paletteItems.length) {
    container.innerHTML = '<div style="padding:12px;color:var(--mute);text-align:center">No matching commands or files</div>';
    return;
  }

  paletteItems.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = `palette-item${idx === 0 ? ' selected' : ''}`;
    el.dataset.idx = idx;

    const binding = KEYMAP[item.id] || '';
    const badge = binding ? `<span class="palette-item-badge">${esc(binding)}</span>` : '';

    el.innerHTML =
      `<div class="palette-item-main">` +
      `  <span class="palette-item-icon">${item.icon}</span>` +
      `  <span class="palette-item-title">${esc(item.title)} <small style="color:var(--faint)">(${esc(item.cat)})</small></span>` +
      `</div>` +
      badge;

    el.onmouseenter = () => selectPaletteIndex(idx);
    el.onclick = () => executePaletteItem(item);
    container.appendChild(el);
  });
}

function selectPaletteIndex(idx) {
  paletteIndex = Math.max(0, Math.min(idx, paletteItems.length - 1));
  const items = $$('#palette-results .palette-item');
  items.forEach((it, i) => it.classList.toggle('selected', i === paletteIndex));
  if (items[paletteIndex]) items[paletteIndex].scrollIntoView({ block: 'nearest' });
}

async function executePaletteItem(item) {
  closeCommandPalette();
  if (!item) return;

  if (item.id.startsWith('jump:')) {
    await openFile(item.path);
  } else if (item.id === 'file:new-note') {
    await promptCreateFile('md');
  } else if (item.id === 'file:new-canvas') {
    await promptCreateFile('canvas');
  } else if (item.id === 'file:new-folder') {
    await promptCreateFolder('');
  } else if (item.id === 'app:switch-vault') {
    $('#btn-open-dir').click();
  } else if (item.id === 'app:toggle-view-mode') {
    setViewMode(B.dataset.mode === 'read' ? 'edit' : 'read');
  } else if (item.id === 'editor:toggle-highlight') {
    toggleHighlight();
  } else if (item.id === 'app:toggle-theme') {
    applyTheme(!dark);
  } else if (item.id === 'app:toggle-left-sidebar') {
    toggleDrawer();
  } else if (item.id === 'app:open-shortcuts') {
    openSettingsModal('shortcuts');
  } else if (item.id === 'app:open-settings') {
    openSettingsModal();
  } else if (item.id === 'app:reload') {
    await reloadTree();
    toast('Workspace reloaded');
  }
}

$('#palette-input').oninput = e => {
  renderPaletteResults(e.target.value);
};

$('#palette-input').onkeydown = e => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectPaletteIndex(paletteIndex + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectPaletteIndex(paletteIndex - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (paletteItems[paletteIndex]) executePaletteItem(paletteItems[paletteIndex]);
  } else if (e.key === 'Escape') {
    closeCommandPalette();
  }
};

$('#palette-modal').onclick = e => {
  if (e.target === $('#palette-modal')) closeCommandPalette();
};

/* ==========================================================================
   SHORTCUTS DIALOG MODAL
   ========================================================================== */
function openShortcutsDialog() {
  const modal = $('#shortcuts-modal');
  const container = $('#shortcuts-list');
  const banner = $('#shortcuts-conflict-banner');
  modal.hidden = false;
  container.innerHTML = '';

  const conflicts = detectHotkeyConflicts();
  if (conflicts.length) {
    banner.hidden = false;
    banner.innerHTML = `<strong>⚠️ Shortcut Conflict Warning:</strong> ` +
      conflicts.map(c => `<code>${c.key}</code> is shared by <em>${c.actions.join('</em> and <em>')}</em>`).join('; ') +
      `. Only the first registered action will trigger.`;
  } else {
    banner.hidden = true;
  }

  for (const [action, key] of Object.entries(KEYMAP)) {
    const row = document.createElement('div');
    const isConf = conflicts.some(c => c.key.toLowerCase() === (key || '').toLowerCase());
    row.className = `shortcut-row${isConf ? ' conflict' : ''}`;
    row.innerHTML =
      `<span class="shortcut-label">${esc(ACTION_DESCRIPTIONS[action] || action)}</span>` +
      `<span class="shortcut-key">${esc(key || 'None')}</span>`;
    container.appendChild(row);
  }
}

function closeShortcutsDialog() {
  $('#shortcuts-modal').hidden = true;
}

$('#btn-close-shortcuts').onclick = closeShortcutsDialog;
$('#btn-done-shortcuts').onclick = closeShortcutsDialog;
$('#btn-reset-shortcuts').onclick = () => {
  resetKeymap();
  saveKeymap();
  openShortcutsDialog();
  toast('Shortcuts reset to defaults');
};
$('#shortcuts-modal').onclick = e => {
  if (e.target === $('#shortcuts-modal')) closeShortcutsDialog();
};

/* ==========================================================================
   SETTINGS MODAL & NOTION SIDEBAR INTERACTIONS
   ========================================================================== */
function openSettingsModal(section) {
  const modal = $('#settings-modal');
  if (!modal) return;
  modal.hidden = false;

  const lightBtn = $('#btn-theme-light');
  const darkBtn = $('#btn-theme-dark');
  if (lightBtn && darkBtn) {
    lightBtn.classList.toggle('active', !dark);
    darkBtn.classList.toggle('active', dark);
  }

  const chk = $('#chk-autosave');
  if (chk) chk.checked = autosaveEnabled;

  const chkRenameTrash = $('#chk-allow-rename-trash');
  if (chkRenameTrash) {
    chkRenameTrash.checked = allowRenameTrash;
    chkRenameTrash.onchange = e => {
      allowRenameTrash = e.target.checked;
      appSettings.allowRenameTrash = allowRenameTrash;
      saveSettings(appSettings);
      renderTree();
    };
  }

  const folderPath = $('#settings-folder-path');
  const vaultTitle = $('#vault-title');
  if (folderPath && vaultTitle) {
    folderPath.textContent = 'Current: ' + (vaultTitle.textContent || 'Not selected');
  }

  if (section === 'shortcuts') {
    const sec = $('#settings-section-shortcuts');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function closeSettingsModal() {
  const modal = $('#settings-modal');
  if (modal) modal.hidden = true;
}

const btnCloseSettings = $('#btn-close-settings');
if (btnCloseSettings) btnCloseSettings.onclick = closeSettingsModal;

const btnDoneSettings = $('#btn-done-settings');
if (btnDoneSettings) btnDoneSettings.onclick = closeSettingsModal;

const settingsModalEl = $('#settings-modal');
if (settingsModalEl) {
  settingsModalEl.onclick = e => {
    if (e.target === settingsModalEl) closeSettingsModal();
  };
}

const btnThemeLight = $('#btn-theme-light');
if (btnThemeLight) {
  btnThemeLight.onclick = () => {
    applyTheme(false);
    btnThemeLight.classList.add('active');
    const darkBtn = $('#btn-theme-dark');
    if (darkBtn) darkBtn.classList.remove('active');
  };
}

const btnThemeDark = $('#btn-theme-dark');
if (btnThemeDark) {
  btnThemeDark.onclick = () => {
    applyTheme(true);
    btnThemeDark.classList.add('active');
    const lightBtn = $('#btn-theme-light');
    if (lightBtn) lightBtn.classList.remove('active');
  };
}

const btnSettingsShortcuts = $('#btn-settings-shortcuts');
if (btnSettingsShortcuts) {
  btnSettingsShortcuts.onclick = () => {
    closeSettingsModal();
    openShortcutsDialog();
  };
}

const btnSettingsOpenFolder = $('#btn-settings-open-folder');
if (btnSettingsOpenFolder) {
  btnSettingsOpenFolder.onclick = () => {
    $('#btn-open-dir').click();
  };
}

const btnOpenSettingsRail = $('#btn-open-settings-rail');
if (btnOpenSettingsRail) btnOpenSettingsRail.onclick = () => openSettingsModal();

const btnWorkspaceSwitch = $('#btn-sidebar-workspace-switch');
if (btnWorkspaceSwitch) {
  btnWorkspaceSwitch.onclick = () => $('#btn-open-dir').click();
}

const btnToggleRightSidebar = $('#btn-toggle-right-sidebar');
if (btnToggleRightSidebar) btnToggleRightSidebar.onclick = () => toggleRightSidebar();

const btnCloseRightSidebar = $('#btn-close-right-sidebar');
if (btnCloseRightSidebar) btnCloseRightSidebar.onclick = () => toggleRightSidebar(false);


function isAnyModalOpen() {
  const modalIds = ['#modal', '#settings-modal', '#shortcuts-modal', '#palette-modal'];
  return modalIds.some(sel => {
    const el = $(sel);
    return el && !el.hidden;
  });
}

/* ==========================================================================
   KEYBOARD DISPATCHER
   ========================================================================== */
window.addEventListener('keydown', async e => {
  if (isAnyModalOpen()) return;

  const isInput = ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName) ||
                  document.activeElement.isContentEditable;

  // Let standard editing keys pass through in text fields
  if (isInput && (e.ctrlKey || e.metaKey)) {
    const k = e.key.toLowerCase();
    if (['z', 'y', 'c', 'v', 'x', 'a'].includes(k)) return;
  }

  // Canvas Delete / Backspace shortcut:
  // selected card or edge is deleted only when canvas board view is active,
  // focus is not in textarea, input or contenteditable, and no modal is open.
  if ((e.key === 'Delete' || e.key === 'Backspace') && !isInput && !isAnyModalOpen()) {
    if (curFile && curFile.type === 'cv' && B.dataset.canvasView === 'board') {
      if (sel) {
        D.nodes = D.nodes.filter(n => n.id !== sel);
        D.edges = D.edges.filter(x => x.fromNode !== sel && x.toNode !== sel);
        sel = null;
        commitCanvas();
        draw();
        throttledUpdateLiveInfo();
        e.preventDefault();
        return;
      } else if (selE) {
        D.edges = D.edges.filter(x => x.id !== selE);
        selE = null;
        commitCanvas();
        draw();
        throttledUpdateLiveInfo();
        e.preventDefault();
        return;
      }
    }
  }

  const combo = normalizeKeyCombo(e);
  if (!combo) return;

  // Disallow bare single-key shortcuts when focus is inside text fields
  const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
  if (isInput && !hasModifier && !/^F\d{1,2}$/i.test(combo) && combo !== 'Delete') {
    return;
  }

  const action = findActionForKey(combo);
  if (!action) return;

  // Action matches bound shortcut: prevent browser default and dispatch
  e.preventDefault();

  switch (action) {
    case 'file:save': {
      const res = await saveActiveFile();
      if (res && res.ok) toast('File saved');
      break;
    }
    case 'file:new-note':
      await promptCreateFile('md');
      break;
    case 'file:new-canvas':
      await promptCreateFile('canvas');
      break;
    case 'file-explorer:move-file':
      if (allowRenameTrash && curPath) await promptRename(curPath);
      break;
    case 'app:delete-file': {
      const inCanvasCard = !!(document.activeElement && document.activeElement.closest('.node'));
      if (isInput || inCanvasCard) break;
      if (allowRenameTrash && curPath) await promptDelete(curPath);
      break;
    }
    case 'workspace:next-tab':
      if (openTabs.length > 1) {
        const curIdx = openTabs.findIndex(t => t.path === curPath);
        const next = openTabs[(curIdx + 1) % openTabs.length];
        await openFile(next.path);
      }
      break;
    case 'workspace:previous-tab':
      if (openTabs.length > 1) {
        const curIdx = openTabs.findIndex(t => t.path === curPath);
        const prev = openTabs[(curIdx - 1 + openTabs.length) % openTabs.length];
        await openFile(prev.path);
      }
      break;
    case 'workspace:close-tab':
      if (curPath) await closeTab(curPath);
      break;
    case 'app:command-palette':
      openCommandPalette();
      break;
    case 'app:toggle-view-mode':
      setViewMode(B.dataset.mode === 'read' ? 'edit' : 'read');
      break;
    case 'app:toggle-theme':
      applyTheme(!dark);
      break;
    case 'app:toggle-left-sidebar':
      toggleDrawer();
      break;
    case 'app:toggle-right-sidebar':
      toggleRightSidebar();
      break;
    case 'app:switch-vault':
      $('#btn-open-dir').click();
      break;
    case 'app:reload':
      await reloadTree();
      toast('Workspace reloaded');
      break;
    case 'editor:toggle-highlight':
      toggleHighlight();
      break;
    case 'app:open-shortcuts':
      openSettingsModal('shortcuts');
      break;
    case 'app:open-settings':
      openSettingsModal();
      break;
  }
});

/* ==========================================================================
   IN-APP FILE OPERATIONS & DIALOGS (RULE 6)
   ========================================================================== */
function showModal({ title, desc, defaultValue = null, validateExtra = null, buttons = null, actions = null, defaultFocus = null }) {
  return new Promise(resolve => {
    const modal = $('#modal');
    $('#modal-title').textContent = title || 'Notice';
    $('#modal-desc').textContent = desc || '';

    const input = $('#modal-input');
    const errEl = $('#modal-err');
    errEl.hidden = true;
    errEl.textContent = '';

    const hasInput = (typeof defaultValue === 'string');
    if (hasInput) {
      input.hidden = false;
      input.value = defaultValue;
    } else {
      input.hidden = true;
      input.value = '';
    }

    const actionsContainer = $('#modal-actions');
    actionsContainer.innerHTML = '';

    const cleanup = () => {
      modal.hidden = true;
      window.removeEventListener('keydown', onKey);
    };

    const validate = () => {
      if (input.hidden) return true;
      const v = input.value.trim();
      if (!v) { errEl.textContent = 'Name cannot be empty'; errEl.hidden = false; return false; }
      if (v.includes('/') || v.includes('\\') || v.includes('..')) {
        errEl.textContent = 'Name cannot contain slashes or relative segments';
        errEl.hidden = false;
        return false;
      }
      if (validateExtra) {
        const customErr = validateExtra(v);
        if (customErr) { errEl.textContent = customErr; errEl.hidden = false; return false; }
      }
      errEl.hidden = true;
      return true;
    };

    const btnList = buttons || actions || [
      { label: 'Cancel', value: false },
      { label: 'OK', value: true, primary: true }
    ];

    let buttonToFocus = null;
    btnList.forEach(btn => {
      const b = document.createElement('button');
      b.textContent = btn.label;
      if (btn.primary) b.className = 'btn-primary';
      if (btn.danger) b.classList.add('btn-danger');
      b.onclick = () => {
        if (btn.value !== false && !input.hidden && !validate()) return;
        cleanup();
        resolve(input.hidden ? btn.value : (btn.value === false ? false : input.value.trim()));
      };
      if (btn.focus || (defaultFocus && btn.label === defaultFocus)) {
        buttonToFocus = b;
      }
      actionsContainer.appendChild(b);
    });

    const onKey = e => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(false);
      } else if (e.key === 'Enter') {
        if (document.activeElement && document.activeElement.tagName === 'BUTTON' && actionsContainer.contains(document.activeElement)) {
          document.activeElement.click();
          return;
        }
        if (document.activeElement === input) {
          const prim = actionsContainer.querySelector('.btn-primary');
          if (prim && !prim.classList.contains('btn-danger')) {
            prim.click();
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);

    modal.hidden = false;
    if (!input.hidden) {
      input.focus();
      input.select();
    } else if (buttonToFocus) {
      buttonToFocus.focus();
    }
  });
}

async function promptCreateFile(type = 'md', targetDir = '') {
  if (!rootTree || !rootTree.children) {
    const choose = await showModal({
      title: 'Select Workspace Folder',
      desc: 'Please select a local folder before creating files.',
      buttons: [
        { label: 'Cancel', value: false },
        { label: 'Select Folder', value: true, primary: true }
      ]
    });
    if (choose) {
      $('#btn-open-dir').click();
    }
    return;
  }

  const isCanvas = (type === 'canvas');
  const ext = isCanvas ? '.canvas' : '.md';
  const defaultBase = isCanvas ? 'Board' : 'Note';

  const name = await showModal({
    title: isCanvas ? 'New Canvas Board' : 'New Markdown Note',
    desc: `Target directory: ${targetDir || 'Vault Root'}`,
    defaultValue: defaultBase,
    validateExtra: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return 'Name cannot be empty';
      if (trimmed.length > 255) return 'Name exceeds 255 characters';
      if (/^[. ]|[. ]$/.test(trimmed)) return 'Name cannot start or end with a dot or space';
      if (/[<>:"/\\|?*]/.test(trimmed)) return 'Name cannot contain < > : " / \\ | ? *';
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed)) return 'Reserved Windows device name not allowed';

      const hasExt = trimmed.toLowerCase().endsWith(ext.toLowerCase());
      const fileName = hasExt ? trimmed : `${trimmed}${ext}`;
      const fullPath = targetDir ? `${targetDir}/${fileName}` : fileName;
      if (fileMap.has(fullPath)) return `A file already exists at ${fullPath}`;
      return null;
    },
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Create', value: true, primary: true }
    ]
  });
  if (!name) return;

  const hasExt = name.toLowerCase().endsWith(ext.toLowerCase());
  const fileName = hasExt ? name : `${name}${ext}`;
  const filePath = targetDir ? `${targetDir}/${fileName}` : fileName;

  try {
    await storage.createFile(filePath);
    const initialContent = isCanvas ? '{"nodes":[],"edges":[]}' : '# ' + name.replace(/\.(md|canvas)$/i, '') + '\n\n';
    const newMtime = await storage.writeText(filePath, initialContent, null, true);
    await reloadTree();
    const entry = fileMap.get(filePath);
    if (entry) entry.mtime = newMtime;
    await openFile(filePath);
    setViewMode('edit');
    toast(`Created ${fileName}`);
  } catch (err) {
    toast('File creation failed: ' + err);
  }
}

async function promptCreateFolder(parentDir = '') {
  if (!rootTree || !rootTree.children) {
    const choose = await showModal({
      title: 'Select Workspace Folder',
      desc: 'Please select a local folder before creating directories.',
      buttons: [
        { label: 'Cancel', value: false },
        { label: 'Select Folder', value: true, primary: true }
      ]
    });
    if (choose) {
      $('#btn-open-dir').click();
    }
    return;
  }

  const folderName = await showModal({
    title: 'New Folder',
    desc: `Parent directory: ${parentDir || 'Vault Root'}`,
    defaultValue: 'Folder',
    validateExtra: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return 'Folder name cannot be empty';
      if (trimmed.length > 255) return 'Folder name exceeds 255 characters';
      if (/^[. ]|[. ]$/.test(trimmed)) return 'Folder name cannot start or end with a dot or space';
      if (/[<>:"/\\|?*]/.test(trimmed)) return 'Folder name cannot contain < > : " / \\ | ? *';
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed)) return 'Reserved Windows device name not allowed';
      return null;
    },
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Create', value: true, primary: true }
    ]
  });
  if (!folderName) return;

  const dirPath = parentDir ? `${parentDir}/${folderName}` : folderName;
  try {
    await storage.createDir(dirPath);
    await reloadTree();
    toast(`Created folder ${folderName}`);
  } catch (err) {
    toast('Folder creation failed: ' + err);
  }
}

async function promptRename(path) {
  if (!allowRenameTrash) {
    toast('Rename and trash operations are disabled in Settings');
    return;
  }
  if (isPathGuarded(path) || !isValidNoteExtension(path)) {
    toast('Protected or invalid file cannot be renamed');
    return;
  }

  const oldName = path.split('/').pop();
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const oldExt = oldName.split('.').pop().toLowerCase();

  const newName = await showModal({
    title: 'Rename Note',
    desc: `Old name: ${oldName}\nWarning: [[links]] to this note will not be updated automatically.`,
    defaultValue: oldName,
    validateExtra: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return 'Name cannot be empty';
      if (trimmed.length > 255) return 'Name exceeds 255 characters';
      if (/^[. ]|[. ]$/.test(trimmed)) return 'Name cannot start or end with a dot or space';
      if (/[<>:"/\\|?*]/.test(trimmed)) return 'Name cannot contain < > : " / \\ | ? *';
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed)) return 'Reserved Windows device name not allowed';

      const newExt = trimmed.includes('.') ? trimmed.split('.').pop().toLowerCase() : '';
      if (newExt !== oldExt) return `Extension change refused: file extension must remain .${oldExt}`;

      const targetPath = dir ? `${dir}/${trimmed}` : trimmed;
      if (targetPath !== path && fileMap.has(targetPath)) return 'A file with this name already exists in this folder';
      return null;
    },
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Rename', value: true, primary: true }
    ]
  });

  if (!newName || newName === oldName) return;
  const newPath = dir ? `${dir}/${newName}` : newName;

  // Await in-flight save for old path
  if (inFlightSaves.has(path)) {
    const res = await inFlightSaves.get(path);
    if (res && !res.ok) {
      toast('Cannot rename: saving changes failed');
      return;
    }
  }

  // If the file is dirty, await saveFile first
  if (curFile && curFile.path === path && curFile.dirty) {
    const res = await saveFile(curFile);
    if (!res.ok) {
      toast('Cannot rename: saving changes failed');
      return;
    }
  }

  // Cancel pending autosave for the old path
  if (autosavePendingFile && autosavePendingFile.path === path) {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    autosavePendingFile = null;
  }

  try {
    await storage.rename(path, newPath);

    const entry = fileMap.get(path);
    if (entry) {
      fileMap.delete(path);
      entry.path = newPath;
      entry.name = newName;
      fileMap.set(newPath, entry);
    }

    const tab = openTabs.find(t => t.path === path);
    if (tab) {
      tab.path = newPath;
      tab.name = newName;
      renderTabs();
    }

    if (curPath === path) {
      curPath = newPath;
      if (curFile) {
        curFile.path = newPath;
        curFile.name = newName;
      }
      updateNoteHeader();
    }

    await reloadTree();
    toast(`Renamed to ${newName}`);
  } catch (err) {
    toast('Rename failed: ' + err);
  }
}

async function promptDelete(path) {
  if (!allowRenameTrash) {
    toast('Rename and trash operations are disabled in Settings');
    return;
  }
  if (isPathGuarded(path) || !isValidNoteExtension(path)) {
    toast('Protected or invalid file cannot be moved to trash');
    return;
  }

  const isOpen = openTabs.some(t => t.path === path);
  const isCurrent = curFile && curFile.path === path;
  const isDirty = isCurrent ? !!curFile.dirty : (openTabs.find(t => t.path === path)?.dirty || false);

  let desc = `Full path: ${path}\n\nMoves to .driftnote-trash inside your vault. Nothing is permanently deleted.`;
  if (isOpen) desc += '\n\nNote: This file is currently open in a tab.';
  if (isDirty) desc += '\nWarning: This file has unsaved edits that will be lost.';

  const confirmed = await showModal({
    title: 'Move to Trash',
    desc,
    defaultValue: null,
    defaultFocus: 'Cancel',
    buttons: [
      { label: 'Cancel', value: false, focus: true },
      { label: 'Move to trash', value: true, primary: true, danger: true }
    ]
  });
  if (!confirmed) return;

  // Await in-flight save for path
  if (inFlightSaves.has(path)) {
    const res = await inFlightSaves.get(path);
    if (res && !res.ok) {
      toast('Cannot move to trash: pending save failed');
      return;
    }
  }

  // Cancel any pending autosave timer for that path
  if (autosavePendingFile && autosavePendingFile.path === path) {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    autosavePendingFile = null;
  }

  const wasDirty = isDirty;
  if (isCurrent) {
    curFile.dirty = false;
  }
  const openT = openTabs.find(t => t.path === path);
  if (openT) openT.dirty = false;

  try {
    const trashName = await storage.trash(path);

    // After a successful trash: ensure no queued save can write the old path
    if (autosavePendingFile && autosavePendingFile.path === path) {
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      autosavePendingFile = null;
    }

    if (isOpen) {
      await closeTab(path, true);
    }
    await reloadTree();

    toastWithAction('Moved to trash', 'Undo', async () => {
      try {
        await storage.restoreFromTrash(trashName, path);
        await reloadTree();
        await openFile(path);
        toast(`Restored ${path.split('/').pop()}`);
      } catch (err) {
        toast(`Restore failed: ${err}`);
      }
    }, 8000);
  } catch (err) {
    if (wasDirty) {
      if (isCurrent) {
        curFile.dirty = true;
        queueSave();
      } else if (openT) {
        openT.dirty = true;
      }
    }
    toast('Delete failed: ' + err);
  }
}

/* ==========================================================================
   UI WIRING & LISTENERS
   ========================================================================== */
$('#rail-files').onclick = () => toggleDrawer();
$('#rail-search').onclick = () => openCommandPalette();
$('#rail-boards').onclick = () => promptCreateFile('canvas');
$('#btn-pin-drawer').onclick = () => togglePinDrawer();
$('#btn-close-drawer').onclick = () => toggleDrawer(false);
$('#btn-open-drawer').onclick = () => toggleDrawer();
$('#drawer-backdrop').onclick = () => toggleDrawer(false);

$('#btn-new-note').onclick = () => promptCreateFile('md');
$('#btn-new-canvas').onclick = () => promptCreateFile('canvas');
$('#btn-new-folder').onclick = () => promptCreateFolder('');
$('#btn-save').onclick = () => saveActiveFile();
$('#chk-autosave').onchange = e => { autosaveEnabled = e.target.checked; };

$('#btn-collapse-all').onclick = () => {
  function collectDirs(node) {
    if (node.kind === 'directory' && node.path) collapsedDirs.add(node.path);
    if (node.children) node.children.forEach(collectDirs);
  }
  if (rootTree) collectDirs(rootTree);
  renderTree();
};

treeEl.onclick = async e => {
  const moreBtn = e.target.closest('[data-action="more"]');
  if (moreBtn) {
    e.stopPropagation();
    const fileRow = moreBtn.closest('.file-row');
    const dirRow = moreBtn.closest('.dir-row');
    const p = fileRow ? fileRow.dataset.p : (dirRow ? dirRow.dataset.d : '');
    openRowMenu(moreBtn, p, !!dirRow);
    return;
  }

  const dirRow = e.target.closest('.dir-row');
  if (dirRow) {
    const p = dirRow.dataset.d;
    if (collapsedDirs.has(p)) collapsedDirs.delete(p); else collapsedDirs.add(p);
    renderTree();
    return;
  }

  const fileRow = e.target.closest('.file-row');
  if (fileRow) await openFile(fileRow.dataset.p);
};

ed.oninput = () => {
  if (!curFile) return;
  curFile.content = ed.value;
  updateStatusPill();
  throttledUpdateLiveInfo(ed.value);
  updateOutline();
  queueSave();
};

js.oninput = () => {
  if (!curFile || canvasBroken) return;
  try {
    JSON.parse(js.value);
    curFile.content = js.value;
    loadCanvas();
    draw();
    throttledUpdateLiveInfo();
    queueSave();
    js.classList.remove('bad');
  } catch (e) {
    js.classList.add('bad');
  }
};

/* External Link Lockdown */
document.addEventListener('click', async e => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();

  if (a.dataset.note) {
    const target = Array.from(fileMap.values()).find(f => f.name.replace(/\.md$/, '') === a.dataset.note);
    if (target) await openFile(target.path);
    else toast('Note not found: ' + a.dataset.note);
  } else if (/^https?:/i.test(a.href) || a.classList.contains('canvas-link')) {
    const destUrl = a.dataset.url || a.href;
    await showModal({
      title: 'External Link Blocked',
      desc: `Network navigation is strictly disabled in offline mode.\nDestination:\n${destUrl}`,
      buttons: [{ label: 'Dismiss', value: true, primary: true }]
    });
  }
});

/* Workspace Selection & Watcher */
$('#btn-open-dir').onclick = async () => {
  try {
    await storage.stopWatch();
    const rootName = await storage.pickRoot();
    if (!rootName) return;
    $('#vault-title').textContent = rootName;
    const settingsFolder = $('#settings-folder-path');
    if (settingsFolder) settingsFolder.textContent = 'Current: ' + rootName;
    imageCache.clear();
    await reloadTree();
    await setupWatcher();
    toast('Workspace mounted');
  } catch (err) {
    if (String(err).includes('canceled')) return;
    toast('Folder selection error: ' + err);
  }
};

const welcomeOpenDir = $('#welcome-btn-open-dir');
if (welcomeOpenDir) welcomeOpenDir.onclick = () => $('#btn-open-dir').click();

const welcomeNewNote = $('#welcome-btn-new-note');
if (welcomeNewNote) welcomeNewNote.onclick = () => promptCreateFile('md');

const welcomeNewBoard = $('#welcome-btn-new-board');
if (welcomeNewBoard) welcomeNewBoard.onclick = () => promptCreateFile('canvas');

let watcherDebounceTimer = null;
let watcherPendingPaths = new Set();

async function handleFsChangedBatch() {
  const paths = Array.from(watcherPendingPaths);
  watcherPendingPaths.clear();

  if (curFile && paths.includes(curFile.path)) {
    try {
      const diskText = await storage.readText(curFile.path);

      // 1. If disk text === curFile.content, do nothing
      if (diskText === curFile.content) {
        await reloadTree();
        return;
      }

      // 2. Disk differs and file is dirty: show conflict dialog
      if (curFile.dirty) {
        await showConflictDialog(curFile.path);
        return;
      }

      // 3. Disk differs and file not dirty: update content while preserving UI state
      curFile.content = diskText;
      await reloadTree();
      const fresh = fileMap.get(curFile.path);
      if (fresh) curFile.mtime = fresh.mtime;

      if (curFile.type === 'md') {
        const isEdFocused = document.activeElement === ed;
        if (!isEdFocused) {
          const selStart = ed.selectionStart;
          const selEnd = ed.selectionEnd;
          const sTop = ed.scrollTop;
          const sLeft = ed.scrollLeft;

          ed.value = curFile.content;

          ed.selectionStart = Math.min(selStart, ed.value.length);
          ed.selectionEnd = Math.min(selEnd, ed.value.length);
          ed.scrollTop = sTop;
          ed.scrollLeft = sLeft;
        }
        await updatePreview();
      } else if (curFile.type === 'cv') {
        const isJsFocused = document.activeElement === js;
        if (!isJsFocused) {
          js.value = curFile.content;
        }
        const prevV = { ...V };
        const prevSel = sel;
        const prevSelE = selE;

        loadCanvas();
        draw();

        V = prevV;
        sel = prevSel;
        selE = prevSelE;
        view();
        renderMinimap();
      }
      toast('Updated from disk');
    } catch (_) {
      await reloadTree();
    }
  } else {
    await reloadTree();
  }
}

async function setupWatcher() {
  await storage.watch(({ paths }) => {
    if (Array.isArray(paths)) {
      paths.forEach(p => watcherPendingPaths.add(p));
    }
    if (watcherDebounceTimer) clearTimeout(watcherDebounceTimer);
    watcherDebounceTimer = setTimeout(() => {
      handleFsChangedBatch();
    }, 300);
  });
}

let toastTimer = null;

function toast(msg) {
  if (toastTimer) clearTimeout(toastTimer);
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

function toastWithAction(msg, actionText, actionFn, duration = 8000) {
  if (toastTimer) clearTimeout(toastTimer);
  const t = $('#toast');
  t.innerHTML = '';
  const textSpan = document.createElement('span');
  textSpan.textContent = msg;
  t.appendChild(textSpan);

  const btn = document.createElement('button');
  btn.className = 'toast-action-btn';
  btn.textContent = actionText;
  btn.onclick = async () => {
    if (toastTimer) clearTimeout(toastTimer);
    t.hidden = true;
    await actionFn();
  };
  t.appendChild(btn);

  t.hidden = false;
  toastTimer = setTimeout(() => { t.hidden = true; }, duration);
}

/* ==========================================================================
   INITIALIZATION
   ========================================================================== */
async function init() {
  updateRightSidebarState();
  updateDrawerState();
  try {
    await reloadTree();
    await setupWatcher();
  } catch (err) {
    if (String(err).includes('No workspace folder selected')) {
      try {
        const rootName = await storage.pickRoot();
        if (rootName) {
          const vaultTitle = $('#vault-title');
          if (vaultTitle) vaultTitle.textContent = rootName;
          const settingsFolder = $('#settings-folder-path');
          if (settingsFolder) settingsFolder.textContent = 'Current: ' + rootName;
          await reloadTree();
          await setupWatcher();
        }
      } catch (pickErr) {
        if (!String(pickErr).includes('canceled')) {
          showErrorBanner('Workspace selection failed: ' + pickErr);
        }
      }
    } else {
      showErrorBanner('Workspace error: ' + err);
    }
  }

  // Restore previous tabs or open first file or show welcome stage
  if (openTabs.length) {
    const first = fileMap.get(openTabs[0].path);
    if (first) {
      await openFile(first.path);
    } else {
      showWelcomeStage(true);
    }
  } else {
    const firstMd = Array.from(fileMap.values()).find(f => f.type === 'md');
    if (firstMd) {
      await openFile(firstMd.path);
    } else {
      showWelcomeStage(true);
    }
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
