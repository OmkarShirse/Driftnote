/* ==========================================================================
   DRIFTNOTE FRONTEND CORE (TAURI V2 OFFLINE NOTES & JSON CANVAS)
   ========================================================================== */

const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const READ_EXTS = ['md', 'canvas', ...IMG_EXTS];

/* ==========================================================================
   IMAGE LRU CACHE (MAX 50)
   ========================================================================== */
class ImageLRUCache {
  constructor(limit = 50) {
    this.limit = limit;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return null;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.limit) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, val);
  }
  clear() {
    this.cache.clear();
  }
}
const imageCache = new ImageLRUCache(50);

function getMimeType(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'svg') return 'image/svg+xml';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'gif') return 'image/gif';
  if (e === 'webp') return 'image/webp';
  return 'application/octet-stream';
}

/* ==========================================================================
   STORAGE ADAPTER (TAURI V2 VS BROWSER BACKEND)
   ========================================================================== */
class TauriBackend {
  constructor() {
    this.core = window.__TAURI__.core;
    this.event = window.__TAURI__.event;
    this.unlistenWatcher = null;
  }
  async pickRoot() {
    return await this.core.invoke('pick_root');
  }
  async listTree() {
    return await this.core.invoke('list_tree');
  }
  async readText(path) {
    return await this.core.invoke('read_text', { path });
  }
  async readBinary(path) {
    return await this.core.invoke('read_binary', { path });
  }
  async writeText(path, content, expectedMtime = null, force = false) {
    return await this.core.invoke('write_text', {
      path,
      content,
      expectedMtime: (expectedMtime !== null && expectedMtime !== undefined) ? expectedMtime : null,
      force: !!force
    });
  }
  async createFile(path) {
    return await this.core.invoke('create_file', { path });
  }
  async createDir(path) {
    return await this.core.invoke('create_dir', { path });
  }
  async rename(from, to) {
    return await this.core.invoke('rename', { from, to });
  }
  async remove(path) {
    return await this.core.invoke('trash', { path });
  }
  async stopWatch() {
    try {
      if (typeof this.unlistenWatcher === 'function') {
        this.unlistenWatcher();
        this.unlistenWatcher = null;
      }
      await this.core.invoke('stop_watch');
    } catch (e) {}
  }
  async watch(callback) {
    await this.stopWatch();
    try {
      await this.core.invoke('start_watch');
      this.unlistenWatcher = await this.event.listen('fs-changed', event => callback(event.payload));
    } catch (err) {
      console.error('Watcher initialization error:', err);
    }
  }
}

class BrowserBackend {
  constructor() {
    this.memoryFiles = new Map();
    this.rootName = 'Local Demo Vault';
    this.seed();
  }
  seed() {
    this.memoryFiles.set('Welcome.md', '# Welcome to Driftnote\n\nOffline Markdown and JSON Canvas workspace.\n\n![[demo.png|300]]');
    this.memoryFiles.set('Board.canvas', JSON.stringify({
      nodes: [
        { id: '1', type: 'text', text: '# Idea\nSimple local notes.', x: 40, y: 40, width: 220, height: 120, color: '4' },
        { id: '2', type: 'text', text: 'Visual Canvas connected.', x: 340, y: 40, width: 220, height: 100, styleAttributes: { shape: 'pill', border: 'dashed', borderWidth: 2 } }
      ],
      edges: [{ id: 'e1', fromNode: '1', toNode: '2' }]
    }, null, 2));
  }
  async pickRoot() { return this.rootName; }
  async listTree() {
    const children = [];
    for (const [path] of this.memoryFiles.entries()) {
      children.push({
        name: path.split('/').pop(),
        path: path,
        kind: 'file',
        mtime: Date.now(),
        children: null
      });
    }
    return { name: this.rootName, path: '', kind: 'directory', mtime: Date.now(), children };
  }
  async readText(path) { return this.memoryFiles.get(path) || ''; }
  async readBinary(_path) { return ''; }
  async writeText(path, content, _expectedMtime, _force) {
    this.memoryFiles.set(path, content);
    return Date.now();
  }
  async createFile(path) {
    this.memoryFiles.set(path, path.endsWith('.canvas') ? '{"nodes":[],"edges":[]}' : '# \n\n');
    return Date.now();
  }
  async createDir() {}
  async rename(from, to) {
    const v = this.memoryFiles.get(from);
    this.memoryFiles.delete(from);
    this.memoryFiles.set(to, v || '');
  }
  async remove(path) { this.memoryFiles.delete(path); }
  async stopWatch() {}
  async watch() {}
}

/* Platform Detection & Backend Initialization */
const isTauriEnv = (typeof window.__TAURI__ !== 'undefined');
const isTauriReady = isTauriEnv && Boolean(window.__TAURI__.core);

if (isTauriEnv && !isTauriReady) {
  const missingBanner = document.getElementById('tauri-missing-banner');
  if (missingBanner) missingBanner.hidden = false;
}

const storage = isTauriReady ? new TauriBackend() : new BrowserBackend();

if (!isTauriReady) {
  const demoBanner = document.getElementById('demo-mode-banner');
  if (demoBanner) demoBanner.hidden = false;
}

/* ==========================================================================
   APP STATE & CONSTANTS
   ========================================================================== */
const $ = s => document.querySelector(s);
const B = document.body, R = document.documentElement;
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COL = { 1: 'var(--c-1)', 2: 'var(--c-2)', 3: 'var(--c-3)', 4: 'var(--c-4)', 5: 'var(--c-5)', 6: 'var(--c-6)' };
const uid = () => Math.random().toString(16).slice(2, 18);

const ed = $('#ed'), pvEl = $('#pv'), js = $('#js'), vp = $('#vp'), world = $('#world'), svg = $('#edges'), info$ = $('#info');
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
    updateCardToolbar();
  });
}

/* Image Viewer State */
let imgZoom = 1.0;
let imgPan = { x: 0, y: 0 };
let imgDragging = false;
let imgDragStart = { x: 0, y: 0, ox: 0, oy: 0 };

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
    const label = themeBtn.querySelector('.btn-label');
    const icon = themeBtn.querySelector('.btn-icon');
    if (label) label.textContent = dark ? 'Dark' : 'Light';
    if (icon) icon.textContent = dark ? '🌙' : '☀️';
  }
  if (B.dataset.type === 'cv' || (curFile && curFile.type === 'cv')) {
    nodeHtmlCache.clear();
    draw();
  }
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
      ADD_TAGS: ['input'],
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

if (typeof marked !== 'undefined') marked.use({ extensions: [{
  name: 'hl', level: 'inline',
  start(src) { return src.indexOf('=='); },
  tokenizer(src) {
    const m = /^==(?!=)([^=\n]+?)==/.exec(src);
    if (m) return { type: 'hl', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
  },
  renderer(tok) { return '<mark>' + this.parser.parseInline(tok.tokens) + '</mark>'; }
}] });
function setWidth(w) {
  B.dataset.width = w;
  localStorage.setItem('dn_width', w);
  $('#btn-width').textContent = w === 'full' ? 'Full width' : 'Readable';
}
setWidth(localStorage.getItem('dn_width') || 'readable');
$('#btn-width').onclick = () => setWidth(B.dataset.width === 'full' ? 'readable' : 'full');
ed.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
    e.preventDefault();
    const s = ed.selectionStart, t = ed.selectionEnd, v = ed.value;
    ed.value = v.slice(0, s) + '==' + v.slice(s, t) + '==' + v.slice(t);
    ed.setSelectionRange(s + 2, t + 2);
    ed.dispatchEvent(new Event('input'));
  }
});

/* ==========================================================================
   MARKDOWN & VAULT IMAGE RESOLUTION (RULES 11 & 12)
   ========================================================================== */
function resolveVaultImage(rawPath, noteDir) {
  const cleanTarget = rawPath.trim().replace(/^[\\/]+/, '');
  if (!cleanTarget) return null;

  // 1. Check relative to note directory first
  if (noteDir) {
    const relCombined = `${noteDir}/${cleanTarget}`.replace(/\/+/g, '/');
    if (fileMap.has(relCombined) && fileMap.get(relCombined).type === 'img') {
      return relCombined;
    }
  }

  // 2. Direct exact match in vault
  if (fileMap.has(cleanTarget) && fileMap.get(cleanTarget).type === 'img') {
    return cleanTarget;
  }

  // 3. Search by filename basename (shortest path wins)
  const targetBase = cleanTarget.split('/').pop().toLowerCase();
  let candidate = null;
  for (const [p, item] of fileMap.entries()) {
    if (item.type === 'img' && item.name.toLowerCase() === targetBase) {
      if (!candidate || p.length < candidate.length) {
        candidate = p;
      }
    }
  }
  return candidate;
}

function renderMarkdown(text) {
  try {
    if (typeof marked !== 'undefined' && marked.parse) {
      // Wiki-image syntax: ![[image.png|width]] or ![[image.png]]
      let processed = String(text || '').replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => {
        const src = a.trim();
        const widthAttr = b ? ` width="${esc(b.trim())}"` : '';
        return `<img data-src="${esc(src)}" alt="${esc(src)}"${widthAttr}>`;
      });

      // Wiki-link syntax: [[target|label]]
      processed = processed.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => {
        return '<a href="#" data-note="' + esc(a.trim()) + '">' + esc(b ? b.trim() : a.trim()) + '</a>';
      });

      const parsed = marked.parse(processed);
      return clean(parsed);
    }
  } catch (e) {}
  return '<pre>' + esc(text) + '</pre>';
}

async function resolvePreviewImages(containerEl, notePath) {
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
  const imgs = containerEl.querySelectorAll('img');

  for (const img of imgs) {
    const rawSrc = img.getAttribute('data-src') || img.getAttribute('src') || '';

    // Hard Rule 2 & 12: Remote URLs are completely blocked and stripped
    if (/^https?:/i.test(rawSrc)) {
      img.remove();
      continue;
    }

    if (rawSrc.startsWith('data:')) continue;

    const resolvedPath = resolveVaultImage(rawSrc, noteDir);
    if (!resolvedPath) {
      const placeholder = document.createElement('span');
      placeholder.className = 'img-missing-badge';
      placeholder.textContent = `Image not found: ${rawSrc}`;
      img.replaceWith(placeholder);
      continue;
    }

    // Check LRU cache
    let dataUrl = imageCache.get(resolvedPath);
    if (!dataUrl) {
      try {
        const b64 = await storage.readBinary(resolvedPath);
        if (b64) {
          const ext = resolvedPath.split('.').pop();
          dataUrl = `data:${getMimeType(ext)};base64,${b64}`;
          imageCache.set(resolvedPath, dataUrl);
        }
      } catch (err) {
        console.error('Failed reading binary image:', err);
      }
    }

    if (dataUrl) {
      img.src = dataUrl;
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'img-missing-badge';
      placeholder.textContent = `Image not found: ${rawSrc}`;
      img.replaceWith(placeholder);
    }
  }
}

async function updatePreview() {
  if (!curFile || curFile.type !== 'md') return;
  pvEl.innerHTML = renderMarkdown(curFile.content || '');
  await resolvePreviewImages(pvEl, curFile.path);
}

/* ==========================================================================
   VIEW MODES & PANES
   ========================================================================== */
function setViewMode(mode) {
  B.dataset.mode = mode;
  const btn = $('#btn-view-mode');
  if (btn) {
    const label = btn.querySelector('.btn-label');
    const icon = btn.querySelector('.btn-icon');
    if (mode === 'edit') {
      if (label) label.textContent = 'Read';
      if (icon) icon.textContent = '📖';
      btn.title = 'Switch to Reading view';
      ed.focus();
    } else {
      if (label) label.textContent = 'Edit';
      if (icon) icon.textContent = '✏️';
      btn.title = 'Switch to Editing view';
      updatePreview();
    }
  }
}

$('#btn-view-mode').onclick = () => {
  const current = B.dataset.mode || 'read';
  setViewMode(current === 'read' ? 'edit' : 'read');
};

$('#btn-canvas-view').onclick = () => {
  const cur = B.dataset.canvasView || 'board';
  const next = cur === 'board' ? 'json' : 'board';
  B.dataset.canvasView = next;
  const btn = $('#btn-canvas-view');
  if (btn) {
    const label = btn.querySelector('.btn-label');
    const icon = btn.querySelector('.btn-icon');
    if (label) label.textContent = next === 'board' ? 'JSON' : 'Board';
    if (icon) icon.textContent = next === 'board' ? '{ }' : '◫';
  }
};

function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2400);
}

function setSaveBadge(state) {
  if (!badgeEl) return;
  badgeEl.className = state;
  if (state === 'saved') badgeEl.textContent = 'Saved';
  else if (state === 'saving') badgeEl.textContent = 'Saving';
  else if (state === 'unsaved') badgeEl.textContent = 'Unsaved';
  else if (state === 'conflict') badgeEl.textContent = 'Conflict';
  else if (state === 'error') badgeEl.textContent = 'Error';
}

/* ==========================================================================
   MODAL PROMPT & CONFIRMATION DIALOGS (RULE 6)
   ========================================================================== */
function showModal({ title, desc, buttons, isPrompt = false, placeholder = '', defaultValue = '', validator = null }) {
  return new Promise(resolve => {
    const modal = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-desc').textContent = desc || '';

    const input = $('#modal-input');
    const errBox = $('#modal-err');
    errBox.hidden = true;
    errBox.textContent = '';

    if (isPrompt) {
      input.hidden = false;
      input.placeholder = placeholder;
      input.value = defaultValue;
      setTimeout(() => { input.focus(); input.select(); }, 50);
    } else {
      input.hidden = true;
    }

    const actions = $('#modal-actions');
    actions.innerHTML = '';

    buttons.forEach(btn => {
      const b = document.createElement('button');
      b.textContent = btn.label;
      if (btn.primary) b.className = 'btn-primary';

      b.onclick = () => {
        if (btn.isSubmit && isPrompt) {
          const val = input.value.trim();
          if (validator) {
            const err = validator(val);
            if (err) {
              errBox.textContent = err;
              errBox.hidden = false;
              input.focus();
              return;
            }
          }
          modal.hidden = true;
          resolve(val);
        } else {
          modal.hidden = true;
          resolve(btn.value);
        }
      };
      actions.appendChild(b);
    });

    if (isPrompt) {
      input.onkeydown = e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const primaryBtn = actions.querySelector('.btn-primary');
          if (primaryBtn) primaryBtn.click();
        } else if (e.key === 'Escape') {
          modal.hidden = true;
          resolve(null);
        }
      };
    }

    modal.hidden = false;
  });
}

function promptNameDialog({ title, desc, defaultValue = '', placeholder = '', validateExtra = null }) {
  return showModal({
    title,
    desc,
    isPrompt: true,
    defaultValue,
    placeholder,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Confirm', isSubmit: true, primary: true }
    ],
    validator: (name) => {
      if (!name) return 'Name cannot be empty';
      if (name.includes('/') || name.includes('\\')) return 'Name cannot contain path separators (/ or \\)';
      if (name.includes('..')) return 'Name cannot contain directory traversal (..)';
      if (name.startsWith('.')) return 'Name cannot start with a dot (.)';
      if (validateExtra) return validateExtra(name);
      return null;
    }
  });
}

/* ==========================================================================
   AUTOSAVE ENGINE (RULE 3 & 4)
   ========================================================================== */
async function saveFile(fileRecord, force = false) {
  if (!fileRecord || !fileRecord.dirty) return;

  // Normal saves send stored mtime; if unknown, refuse with an error
  if (!force && (typeof fileRecord.mtime !== 'number' || fileRecord.mtime <= 0)) {
    setSaveBadge('error');
    toast(`Save refused for ${fileRecord.name}: unknown file mtime`);
    return;
  }

  if (curFile && curFile.path === fileRecord.path) setSaveBadge('saving');

  try {
    const newMtime = await storage.writeText(
      fileRecord.path,
      fileRecord.content || '',
      force ? null : fileRecord.mtime,
      force
    );
    fileRecord.mtime = newMtime;
    fileRecord.dirty = false;
    if (fileMap.has(fileRecord.path)) fileMap.get(fileRecord.path).mtime = newMtime;
    if (curFile && curFile.path === fileRecord.path) setSaveBadge('saved');
  } catch (err) {
    if (String(err).includes('Conflict')) {
      if (curFile && curFile.path === fileRecord.path) {
        await showConflictDialog(fileRecord.path);
      }
    } else {
      if (curFile && curFile.path === fileRecord.path) setSaveBadge('error');
      toast(`Save error: ${err}`);
    }
  }
}

async function saveActiveFile() {
  if (!curFile) return;
  await saveFile(curFile, false);
}

function queueSave() {
  if (!curFile) return;
  if (canvasBroken && curFile.type === 'cv') return; // Canvas Safety: never overwrite corrupted file

  curFile.dirty = true;
  setSaveBadge('unsaved');
  if (!autosaveEnabled) return;

  autosavePendingFile = curFile; // Track the exact file edited
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    if (autosavePendingFile) {
      const f = autosavePendingFile;
      autosavePendingFile = null;
      await saveFile(f, false);
    }
  }, 650);
}

/* Conflict Resolution Dialog */
async function showConflictDialog(path) {
  setSaveBadge('conflict');
  const action = await showModal({
    title: 'File Conflict Detected',
    desc: `"${path}" changed on disk externally while you have unsaved edits.`,
    buttons: [
      { label: 'Keep mine (overwrite)', value: 'keep', primary: true },
      { label: 'Load disk version', value: 'load' },
      { label: 'Save as copy', value: 'copy' }
    ]
  });

  if (action === 'keep') {
    try {
      setSaveBadge('saving');
      const newMtime = await storage.writeText(curFile.path, curFile.content || '', null, true);
      curFile.mtime = newMtime;
      if (fileMap.has(curFile.path)) fileMap.get(curFile.path).mtime = newMtime;
      curFile.dirty = false;
      setSaveBadge('saved');
      toast('Kept local edits');
    } catch (err) {
      setSaveBadge('error');
      toast('Save error: ' + err);
    }
  } else if (action === 'load') {
    curFile.content = await storage.readText(path);
    await reloadTree();
    const fresh = fileMap.get(path);
    if (fresh) curFile.mtime = fresh.mtime;
    curFile.dirty = false;
    ed.value = curFile.content;
    await updatePreview();
    setSaveBadge('saved');
    toast('Loaded disk version');
  } else if (action === 'copy') {
    const ext = curFile.type === 'cv' ? '.canvas' : '.md';
    const copyPath = path.replace(new RegExp(`${ext}$`), `-copy-${Date.now()}${ext}`);
    try {
      const createdMtime = await storage.createFile(copyPath);
      const newMtime = await storage.writeText(copyPath, curFile.content || '', null, true);
      await reloadTree();
      const entry = fileMap.get(copyPath);
      if (entry) entry.mtime = newMtime;
      await openFile(copyPath);
      toast('Saved as copy');
    } catch (err) {
      setSaveBadge('error');
      toast('Error saving copy: ' + err);
    }
  }
}

/* ==========================================================================
   TREE INDEXING & PRESERVING DIRTY CONTENT (RULE 3)
   ========================================================================== */
async function reloadTree() {
  try {
    rootTree = await storage.listTree();
    const oldMap = fileMap;
    fileMap = new Map();

    function index(node) {
      if (node.kind === 'file') {
        const ext = node.name.split('.').pop().toLowerCase();
        let ftype = 'md';
        if (ext === 'canvas') ftype = 'cv';
        else if (IMG_EXTS.includes(ext)) ftype = 'img';

        const existing = oldMap.get(node.path);
        if (existing) {
          // Merge and NEVER drop dirty content
          fileMap.set(node.path, {
            name: node.name,
            path: node.path,
            type: ftype,
            mtime: existing.dirty ? existing.mtime : node.mtime,
            content: existing.content,
            dirty: existing.dirty
          });
        } else {
          fileMap.set(node.path, {
            name: node.name,
            path: node.path,
            type: ftype,
            mtime: node.mtime,
            content: null,
            dirty: false
          });
        }
      }
      if (node.children) node.children.forEach(index);
    }
    index(rootTree);
    $('#vault-title').textContent = rootTree.name;
    renderTree();
  } catch (err) {
    setSaveBadge('error');
  }
}

function renderTree() {
  if (!rootTree) {
    treeEl.innerHTML = '<p class="mute" style="padding:10px 6px">No folder open.</p>';
    return;
  }
  treeEl.innerHTML = renderNode(rootTree, true);
}

function renderNode(node, isRoot = false) {
  if (node.kind === 'directory') {
    const isClosed = collapsedDirs.has(node.path);
    let html = '';
    if (!isRoot) {
      html += '<div class="tree-dir">';
      html += '  <div class="tree-row dir-row" data-d="' + esc(node.path) + '">';
      html += '    <span class="chevron">' + (isClosed ? '▸' : '▾') + '</span>';
      html += '    <span class="icon">📁</span>';
      html += '    <span class="title">' + esc(node.name) + '</span>';
      html += '    <div class="row-actions">';
      html += '      <button class="row-btn btn-row-newfile" title="New file here" data-action="newfile">📄+</button>';
      html += '      <button class="row-btn btn-row-del" title="Delete folder" data-action="delete">🗑️</button>';
      html += '    </div>';
      html += '  </div>';
      html += '  <div class="tree-sub' + (isClosed ? ' collapsed' : '') + '">';
    } else {
      html += '<div class="tree-sub" style="margin-left:0;padding-left:0;border-left:0">';
    }
    for (const child of node.children) html += renderNode(child, false);
    html += '  </div>';
    if (!isRoot) html += '</div>';
    return html;
  }

  const isAct = node.path === curPath;
  const ext = node.name.split('.').pop().toLowerCase();
  let icon = '📄';
  if (ext === 'canvas') icon = '◫';
  else if (IMG_EXTS.includes(ext)) icon = '🖼️';

  return '<div class="tree-row file-row' + (isAct ? ' active' : '') + '" data-p="' + esc(node.path) + '">' +
    '  <span class="chevron" style="opacity:0">•</span>' +
    '  <span class="icon">' + icon + '</span>' +
    '  <span class="title">' + esc(node.name) + '</span>' +
    '  <div class="row-actions">' +
    '    <button class="row-btn btn-row-rename" title="Rename" data-action="rename">✏️</button>' +
    '    <button class="row-btn btn-row-del" title="Delete (Move to trash)" data-action="delete">🗑️</button>' +
    '  </div>' +
    '</div>';
}

/* ==========================================================================
   IMAGE VIEWER ENGINE (RULE 11 & ROUND 3 RULE 4)
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

  // Flush dirty content of previous file before switching
  if (curFile && curFile.dirty) {
    await saveFile(curFile, false);
  }

  curPath = path;
  curFile = f;
  sel = selE = null;
  B.dataset.type = 'img';
  $('#title').textContent = f.name;

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
  updateOutline();
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
   OPEN FILE & FLUSHING ON SWITCH (RULE 3)
   ========================================================================== */
async function openFile(path) {
  const f = fileMap.get(path);
  if (!f) return;

  // Flush before switching files
  if (curFile && curFile.dirty && curFile.path !== path) {
    await saveFile(curFile, false);
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
  $('#title').textContent = f.name;

  if (f.type === 'md') {
    $('#btn-view-mode').style.display = 'inline-flex';
    $('#btn-canvas-view').style.display = 'none';
    ed.value = f.content || '';
    await updatePreview();
  } else {
    $('#btn-view-mode').style.display = 'none';
    $('#btn-canvas-view').style.display = 'inline-flex';
    loadCanvas();
    V = { x: 60, y: 80, z: 1 };
    view();
    draw();
    js.value = f.content || '';
  }

  treeEl.querySelectorAll('.file-row').forEach(r => r.classList.toggle('active', r.dataset.p === curPath));
  updateOutline();
  setSaveBadge(f.dirty ? 'unsaved' : 'saved');
}

/* ==========================================================================
   CANVAS CORE & INPUT PORT (RULE 1, 2, 13 & ADVANCED STYLING)
   ========================================================================== */
function loadCanvas() {
  canvasBroken = false;
  const brokenBanner = $('#canvas-broken-banner');
  if (brokenBanner) brokenBanner.hidden = true;

  try {
    const raw = JSON.parse(curFile.content || '{"nodes":[],"edges":[]}');
    D = {
      ...raw,
      nodes: (raw.nodes || []).filter(n => n && n.id),
      edges: (raw.edges || []).filter(e => e && e.fromNode && e.toNode)
    };
  } catch (e) {
    // Canvas Safety: set canvasBroken, show banner, disable edits and autosave
    canvasBroken = true;
    D = { nodes: [], edges: [] };
    if (brokenBanner) brokenBanner.hidden = false;
    toast('Corrupted canvas file: edits disabled');
    return;
  }

  // Safety: default and Number()-coerce x,y,width,height
  D.nodes.forEach(n => {
    n.type = n.type || 'text';
    n.x = Number(n.x) || 0;
    n.y = Number(n.y) || 0;
    n.width = Math.max(60, Number(n.width) || 240);
    n.height = Math.max(40, Number(n.height) || 100);
    n.styleAttributes = n.styleAttributes || {};
  });
}

function commitCanvas() {
  if (!curFile || canvasBroken) return;
  curFile.content = JSON.stringify(D, null, 1);
  js.value = curFile.content;
  queueSave();
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
  svg.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>' +
    D.edges.map(e => {
      const a = D.nodes.find(n => n.id === e.fromNode), b = D.nodes.find(n => n.id === e.toNode);
      if (!a || !b) return '';
      const [fs, ts] = sides(a, b, e), p = anc(a, fs), q = anc(b, ts);
      if (!p || !q) return '';
      const d = 'M' + p[0] + ' ' + p[1] + 'C' + (p[0] + DX[fs] * 80) + ' ' + (p[1] + DY[fs] * 80) + ' ' + (q[0] + DX[ts] * 80) + ' ' + (q[1] + DY[ts] * 80) + ' ' + q[0] + ' ' + q[1];
      return '<path class="h" data-id="' + esc(e.id) + '" d="' + d + '"/>' +
             '<path class="v' + (e.id === selE ? ' sel' : '') + '" d="' + d + '"' + (e.toEnd === 'none' ? '' : ' marker-end="url(#ah)"') + '/>';
    }).join('') + (previewPath ? '<path class="dr" d="' + previewPath + '"/>' : '');
}

/* Shape Geometry (0..100 viewBox with vector-effect="non-scaling-stroke") */
function getShapeSvgPath(shape) {
  switch (shape) {
    case 'rectangle':
      return '<polygon points="0,0 100,0 100,100 0,100" vector-effect="non-scaling-stroke"/>';
    case 'pill':
      return '<rect x="0" y="0" width="100" height="100" rx="50" ry="50" vector-effect="non-scaling-stroke"/>';
    case 'circle':
      return '<ellipse cx="50" cy="50" rx="49" ry="49" vector-effect="non-scaling-stroke"/>';
    case 'diamond':
      return '<polygon points="50,1 99,50 50,99 1,50" vector-effect="non-scaling-stroke"/>';
    case 'parallelogram':
      return '<polygon points="18,1 99,1 82,99 1,99" vector-effect="non-scaling-stroke"/>';
    case 'document':
      return '<path d="M 1,1 L 99,1 L 99,84 Q 75,100 50,84 Q 25,68 1,84 Z" vector-effect="non-scaling-stroke"/>';
    case 'database':
      return '<path d="M 1,18 A 49,15 0 0,0 99,18 L 99,82 A 49,15 0 0,1 1,82 Z M 1,18 A 49,15 0 1,1 99,18 A 49,15 0 1,1 1,18 Z" vector-effect="non-scaling-stroke"/>';
    case 'default':
    default:
      return '<rect x="1" y="1" width="98" height="98" rx="8" ry="8" vector-effect="non-scaling-stroke"/>';
  }
}

function renderNodeShapeSvg(n) {
  if (n.type === 'group') return '';
  const sa = n.styleAttributes || {};
  const shape = sa.shape || 'default';
  const border = sa.border || 'default';
  const borderWidth = Math.max(1, Math.min(6, Number(sa.borderWidth || n.borderWidth) || 1.5));

  const nodeColor = n.color ? (COL[n.color] || n.color) : null;
  const strokeColor = nodeColor || 'var(--line-strong)';
  let strokeDash = 'none';
  let strokeAttr = strokeColor;

  if (border === 'dashed') strokeDash = '6,4';
  else if (border === 'dotted') strokeDash = '2,3';
  else if (border === 'invisible') strokeAttr = 'none';

  const fillColor = nodeColor
    ? `color-mix(in srgb, ${nodeColor} 10%, var(--card-bg))`
    : 'var(--card-bg)';

  const shapeElement = getShapeSvgPath(shape);
  return `<svg class="node-shape-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
    <g fill="${fillColor}" stroke="${strokeAttr}" stroke-width="${borderWidth}" stroke-dasharray="${strokeDash}">
      ${shapeElement}
    </g>
  </svg>`;
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
      // Rule 13: Canvas file cards that point to an image render the image
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
          } catch (e) {}
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

    const c = n.color ? (COL[n.color] || n.color) : '';
    if (c) {
      el.style.setProperty('--node-color', c);
      el.dataset.colored = 'true';
    }

    const sa = n.styleAttributes || {};
    let padClass = '';
    if (sa.shape === 'circle') padClass = ' pad-circle';
    else if (sa.shape === 'diamond') padClass = ' pad-diamond';

    el.innerHTML = renderNodeShapeSvg(n) +
      `<div class="body${padClass}"></div>` +
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
  const z = Math.min(3.0, Math.max(0.1, V.z * factor));
  if (z === V.z) return;
  V.x = mx - (mx - V.x) * z / V.z;
  V.y = my - (my - V.y) * z / V.z;
  V.z = z;
  requestViewUpdate();
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
    draw();
    updateOutline();
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
    styleAttributes: { shape: 'default', border: 'default', borderWidth: 2 }
  };
  if (type === 'text') n.text = '';
  else n.label = 'Group';

  D.nodes.push(n);
  sel = n.id;
  commitCanvas();
  draw();
  updateOutline();
  const el = world.querySelector('[data-id="' + n.id + '"]');
  if (el) editNode(el);
}

function mid(w, h) {
  const r = vp.getBoundingClientRect(), p = toW(r.left + r.width / 2, r.top + r.height / 2);
  return [p[0] - w / 2, p[1] - h / 2];
}

/* ==========================================================================
   FLOATING CARD TOOLBAR (RULE 2 CANVAS STYLING)
   ========================================================================== */
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
  $('#tb-shape').value = sa.shape || 'default';
  $('#tb-border').value = sa.border || 'default';
  $('#tb-width').value = sa.borderWidth || n.borderWidth || 2;

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
    updateOutline();
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
    updateOutline();
  };
}

$('#tb-shape').onchange = e => {
  if (!sel) return;
  const n = D.nodes.find(x => x.id === sel);
  if (!n) return;
  n.styleAttributes = { ...(n.styleAttributes || {}), shape: e.target.value };
  commitCanvas();
  draw();
  updateOutline();
};

$('#tb-border').onchange = e => {
  if (!sel) return;
  const n = D.nodes.find(x => x.id === sel);
  if (!n) return;
  n.styleAttributes = { ...(n.styleAttributes || {}), border: e.target.value };
  commitCanvas();
  draw();
  updateOutline();
};

$('#tb-width').oninput = e => {
  if (!sel) return;
  const n = D.nodes.find(x => x.id === sel);
  if (!n) return;
  n.styleAttributes = { ...(n.styleAttributes || {}), borderWidth: Number(e.target.value) };
  commitCanvas();
  draw();
  updateOutline();
};

$('#tb-del').onclick = () => {
  if (!sel) return;
  D.nodes = D.nodes.filter(n => n.id !== sel);
  D.edges = D.edges.filter(x => x.fromNode !== sel && x.toNode !== sel);
  sel = null;
  commitCanvas();
  draw();
  updateOutline();
};

/* ==========================================================================
   CANVAS POINTER & WHEEL LISTENERS (PORT FROM V1, RULE 1)
   ========================================================================== */
vp.onpointerdown = e => {
  if (e.target.closest('textarea, select, input, button, #card-toolbar')) return;
  const el = e.target.closest('.node');
  const n = el && D.nodes.find(x => x.id === el.dataset.id);
  const hp = e.target.closest('path.h');

  sel = n ? n.id : null;
  selE = hp ? hp.dataset.id : null;

  world.querySelectorAll('.node').forEach(x => x.classList.toggle('sel', x.dataset.id === sel));
  edges();
  updateOutline();
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
      updateOutline();
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
  if (e.target.closest('path, #card-toolbar, .ctl')) return;
  const p = toW(e.clientX, e.clientY);
  addNode(p[0] - 120, p[1] - 50, 'text');
};

$('#ac').onclick = () => { const p = mid(240, 100); addNode(p[0], p[1], 'text'); };
$('#ag').onclick = () => { const p = mid(420, 300); addNode(p[0], p[1], 'group'); };
$('#zi').onclick = () => { const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.2); };
$('#zo').onclick = () => { const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.2); };
$('#zr').onclick = () => { V = { x: 60, y: 80, z: 1 }; requestViewUpdate(); };

/* ==========================================================================
   PANEL OUTLINE & STYLE SECTION
   ========================================================================== */
function updateOutline() {
  if (!curFile) { info$.innerHTML = ''; return; }

  if (curFile.type === 'md') {
    const hs = [...(curFile.content || '').matchAll(/^(#{1,6})\s+(.+)$/gm)];
    info$.innerHTML = '<h3>Outline</h3>' + (hs.length ? hs.map((m, i) => {
      return '<a href="#" data-h="' + i + '" style="padding-left:' + (m[1].length - 1) * 12 + 'px">' + esc(m[2]) + '</a>';
    }).join('') : '<p class="mute">No headings yet.</p>');
  } else if (curFile.type === 'cv') {
    const n = D.nodes.find(x => x.id === sel);
    let html = '<h3>Canvas</h3><p class="mute">' + D.nodes.length + ' cards, ' + D.edges.length + ' links</p>';

    if (n && n.type !== 'group') {
      const sa = n.styleAttributes || {};
      html += '<h3>Card Style</h3>';
      html += '<div class="style-control-row"><label>Shape</label><select id="pnl-shape">' +
        ['default', 'rectangle', 'pill', 'circle', 'diamond', 'parallelogram', 'document', 'database'].map(s => {
          return `<option value="${s}"${(sa.shape || 'default') === s ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`;
        }).join('') + '</select></div>';

      html += '<div class="style-control-row"><label>Border</label><select id="pnl-border">' +
        ['default', 'dashed', 'dotted', 'invisible'].map(b => {
          return `<option value="${b}"${(sa.border || 'default') === b ? ' selected' : ''}>${b[0].toUpperCase() + b.slice(1)}</option>`;
        }).join('') + '</select></div>';

      html += '<div class="style-control-row"><label>Border Width</label><input type="range" id="pnl-width" min="1" max="6" value="' + (sa.borderWidth || n.borderWidth || 2) + '"></div>';

      html += '<div class="style-control-row"><label>Color</label><div class="sw">' + ['', 1, 2, 3, 4, 5, 6].map(k => {
        return '<button data-c="' + k + '" style="background:' + (k ? (COL[k] || k) : 'transparent') + '"' + ((n.color || '') == k ? ' class="on"' : '') + '>' + (k ? '' : '∅') + '</button>';
      }).join('') + '<input type="color" id="pnl-custom-color" value="' + (n.color && String(n.color).startsWith('#') ? n.color : '#3366cc') + '" style="width:24px;height:24px;padding:0;border:1px solid var(--line);border-radius:4px;cursor:pointer" title="Custom color"></div></div>';
    } else {
      html += '<p class="mute" style="margin-top:12px">Select a card to adjust style.</p>';
    }
    info$.innerHTML = html;
  }
}

info$.onclick = e => {
  const a = e.target.closest('[data-h]');
  const c = e.target.closest('[data-c]');
  if (a) {
    e.preventDefault();
    setViewMode('read');
    const h = pvEl.querySelectorAll('h1,h2,h3,h4,h5,h6')[a.dataset.h];
    if (h) h.scrollIntoView({ block: 'start' });
  }
  if (c) {
    const n = D.nodes.find(x => x.id === sel);
    if (!n) return;
    if (c.dataset.c) n.color = c.dataset.c; else delete n.color;
    commitCanvas();
    draw();
    updateOutline();
  }
};

info$.oninput = info$.onchange = e => {
  if (!sel) return;
  const n = D.nodes.find(x => x.id === sel);
  if (!n) return;

  if (e.target.id === 'pnl-shape') {
    n.styleAttributes = { ...(n.styleAttributes || {}), shape: e.target.value };
    commitCanvas();
    draw();
    updateOutline();
  } else if (e.target.id === 'pnl-border') {
    n.styleAttributes = { ...(n.styleAttributes || {}), border: e.target.value };
    commitCanvas();
    draw();
    updateOutline();
  } else if (e.target.id === 'pnl-width') {
    n.styleAttributes = { ...(n.styleAttributes || {}), borderWidth: Number(e.target.value) };
    commitCanvas();
    draw();
    updateOutline();
  } else if (e.target.id === 'pnl-custom-color') {
    n.color = e.target.value;
    commitCanvas();
    draw();
    updateOutline();
  }
};

/* ==========================================================================
   IN-APP FILE OPERATIONS (RULE 6)
   ========================================================================== */
async function promptCreateFile(type = 'md', targetDir = '') {
  const isCanvas = (type === 'canvas');
  const ext = isCanvas ? '.canvas' : '.md';

  const name = await promptNameDialog({
    title: isCanvas ? 'New Canvas Board' : 'New Markdown Note',
    desc: 'Enter file name (without path):',
    placeholder: isCanvas ? 'Board' : 'Note',
    validateExtra: (rawName) => {
      const fullPath = targetDir ? `${targetDir}/${rawName}${rawName.endsWith(ext) ? '' : ext}` : `${rawName}${rawName.endsWith(ext) ? '' : ext}`;
      if (fileMap.has(fullPath)) return 'A file with this name already exists in this folder';
      return null;
    }
  });
  if (!name) return;

  const fileName = name.endsWith(ext) ? name : `${name}${ext}`;
  const filePath = targetDir ? `${targetDir}/${fileName}` : fileName;

  try {
    const createdMtime = await storage.createFile(filePath);
    const initialContent = isCanvas ? '{"nodes":[],"edges":[]}' : '# ' + name.replace(/\.(md|canvas)$/, '') + '\n\n';
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
  const folderName = await promptNameDialog({
    title: 'New Folder',
    desc: 'Enter directory name:',
    placeholder: 'Folder'
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
  const oldName = path.split('/').pop();
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const isDir = !path.includes('.') || !fileMap.has(path);

  const newName = await promptNameDialog({
    title: isDir ? 'Rename Folder' : 'Rename File',
    desc: `Rename "${oldName}" to:`,
    defaultValue: oldName,
    validateExtra: (name) => {
      const newPath = dir ? `${dir}/${name}` : name;
      if (newPath === path) return 'Name unchanged';
      if (fileMap.has(newPath)) return 'Target name already exists';
      if (!isDir) {
        const ext = name.split('.').pop().toLowerCase();
        if (!READ_EXTS.includes(ext)) return `Extension .${ext} not permitted`;
      }
      return null;
    }
  });
  if (!newName || newName === oldName) return;

  const newPath = dir ? `${dir}/${newName}` : newName;
  try {
    await storage.rename(path, newPath);
    await reloadTree();
    if (curPath === path) {
      await openFile(newPath);
    }
    toast(`Renamed to ${newName}`);
  } catch (err) {
    toast('Rename failed: ' + err);
  }
}

async function promptDelete(path) {
  const fileName = path.split('/').pop();
  const confirm = await showModal({
    title: 'Move to Trash',
    desc: `Are you sure you want to move "${fileName}" to the vault trash?`,
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Move to Trash', value: true, primary: true }
    ]
  });
  if (!confirm) return;

  try {
    await storage.remove(path);
    if (curPath === path) {
      curPath = null;
      curFile = null;
      $('#title').textContent = 'No file open';
      ed.value = '';
      pvEl.innerHTML = '';
      D = { nodes: [], edges: [] };
      draw();
      setSaveBadge('saved');
    }
    await reloadTree();
    toast(`Moved ${fileName} to trash`);
  } catch (err) {
    toast('Delete failed: ' + err);
  }
}

/* ==========================================================================
   TREE EVENT LISTENERS
   ========================================================================== */
treeEl.onclick = async e => {
  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.dataset.action;
    const fileRow = actionBtn.closest('.file-row');
    const dirRow = actionBtn.closest('.dir-row');

    if (action === 'delete') {
      const p = (fileRow ? fileRow.dataset.p : dirRow && dirRow.dataset.d);
      if (p) await promptDelete(p);
    } else if (action === 'rename') {
      const p = fileRow && fileRow.dataset.p;
      if (p) await promptRename(p);
    } else if (action === 'newfile') {
      const d = dirRow && dirRow.dataset.d;
      if (d) await promptCreateFile('md', d);
    }
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

$('#btn-collapse-all').onclick = () => {
  function collectDirs(node) {
    if (node.kind === 'directory' && node.path) collapsedDirs.add(node.path);
    if (node.children) node.children.forEach(collectDirs);
  }
  if (rootTree) collectDirs(rootTree);
  renderTree();
};

$('#btn-new-note').onclick = () => promptCreateFile('md');
$('#btn-new-canvas').onclick = () => promptCreateFile('canvas');
$('#btn-new-folder').onclick = () => promptCreateFolder('');

/* ==========================================================================
   KEYBOARD SHORTCUTS & INPUT LISTENERS (RULE 1 CANVAS DELETE KEY)
   ========================================================================== */
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveActiveFile();
  }

  // Delete key on canvas
  if (curFile && curFile.type === 'cv' && B.dataset.canvasView === 'board' && !['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName)) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (sel) {
        D.nodes = D.nodes.filter(n => n.id !== sel);
        D.edges = D.edges.filter(x => x.fromNode !== sel && x.toNode !== sel);
        sel = null;
        commitCanvas();
        draw();
        updateOutline();
      } else if (selE) {
        D.edges = D.edges.filter(x => x.id !== selE);
        selE = null;
        commitCanvas();
        draw();
        updateOutline();
      }
    }
  }
});

ed.oninput = () => {
  if (!curFile) return;
  curFile.content = ed.value;
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
    updateOutline();
    queueSave();
    js.classList.remove('bad');
  } catch (e) {
    js.classList.add('bad');
  }
};

/* ==========================================================================
   NAVIGATION LOCKDOWN & IN-APP MODAL (RULE 4)
   ========================================================================== */
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

/* ==========================================================================
   WORKSPACE SELECTION & WATCHER (RULE 7)
   ========================================================================== */
$('#btn-open-dir').onclick = async () => {
  try {
    await storage.stopWatch();
    const rootName = await storage.pickRoot();
    $('#vault-title').textContent = rootName;
    imageCache.clear();
    await reloadTree();
    await setupWatcher();
    toast('Workspace mounted');
  } catch (err) {
    toast('Folder selection error: ' + err);
  }
};

$('#btn-save').onclick = () => saveActiveFile();
$('#chk-autosave').onchange = e => { autosaveEnabled = e.target.checked; };
$('#btn-toggle-files').onclick = () => { B.classList.toggle('nf'); };
$('#btn-toggle-info').onclick = () => { B.classList.toggle('ni'); };

async function setupWatcher() {
  await storage.watch(async ({ paths }) => {
    if (curFile && paths.includes(curFile.path)) {
      if (curFile.dirty) {
        await showConflictDialog(curFile.path);
      } else {
        curFile.content = await storage.readText(curFile.path);
        await reloadTree();
        const fresh = fileMap.get(curFile.path);
        if (fresh) curFile.mtime = fresh.mtime;

        if (curFile.type === 'md') {
          ed.value = curFile.content;
          await updatePreview();
        } else if (curFile.type === 'cv') {
          loadCanvas();
          draw();
        }
        updateOutline();
        toast('Updated from disk');
      }
    } else {
      await reloadTree();
    }
  });
}

/* ==========================================================================
   INITIALIZATION
   ========================================================================== */
async function init() {
  await reloadTree();
  await setupWatcher();
}
init();
