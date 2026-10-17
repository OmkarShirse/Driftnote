/* ==========================================================================
   STORAGE ADAPTER PATTERN (TAURI V2 VS BROWSER BACKEND)
   ========================================================================== */
class TauriBackend {
  constructor() {
    this.core = window.__TAURI__.core;
    this.event = window.__TAURI__.event;
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
  async watch(callback) {
    await this.core.invoke('start_watch');
    return await this.event.listen('fs-changed', event => callback(event.payload));
  }
}

class BrowserBackend {
  constructor() {
    this.memoryFiles = new Map();
    this.rootName = 'Local Notes';
    this.seed();
  }
  seed() {
    this.memoryFiles.set('Welcome.md', '# Welcome to Driftnote\n\nOffline Markdown and JSON Canvas workspace.');
    this.memoryFiles.set('Board.canvas', '{"nodes":[],"edges":[]}');
  }
  async pickRoot() {
    return this.rootName;
  }
  async listTree() {
    const children = [];
    for (const [path] of this.memoryFiles.entries()) {
      children.push({
        name: path,
        path: path,
        kind: 'file',
        mtime: Date.now(),
        children: null
      });
    }
    return { name: this.rootName, path: '', kind: 'directory', mtime: Date.now(), children };
  }
  async readText(path) {
    return this.memoryFiles.get(path) || '';
  }
  async readBinary(_path) {
    return '';
  }
  async writeText(path, content) {
    this.memoryFiles.set(path, content);
    return Date.now();
  }
  async createFile(path) {
    this.memoryFiles.set(path, path.endsWith('.canvas') ? '{"nodes":[],"edges":[]}' : '# \n\n');
    return Date.now();
  }
  async createDir() {}
  async rename(from, to) {
    const val = this.memoryFiles.get(from);
    this.memoryFiles.delete(from);
    this.memoryFiles.set(to, val || '');
  }
  async remove(path) {
    this.memoryFiles.delete(path);
  }
  async watch() {}
}

const storage = (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.core)
  ? new TauriBackend()
  : new BrowserBackend();

/* ==========================================================================
   APP STATE & CONSTANTS
   ========================================================================== */
const $ = s => document.querySelector(s);
const B = document.body, R = document.documentElement;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COL = { 1: '#e5484d', 2: '#f08a24', 3: '#d9a900', 4: '#30a46c', 5: '#3366cc', 6: '#8e4ec6' };
const uid = () => Math.random().toString(16).slice(2, 18);

const ed = $('#ed'), pvEl = $('#pv'), js = $('#js'), vp = $('#vp'), world = $('#world'), svg = $('#edges'), info$ = $('#info');
const treeEl = $('#file-tree'), badgeEl = $('#status-badge');

let rootTree = null;
let fileMap = new Map();
let curPath = null;
let curFile = null;
let autosaveEnabled = true;
let autosaveTimer = null;
let collapsedDirs = new Set();
let D = { nodes: [], edges: [] };
let sel = null, selE = null, V = { x: 60, y: 80, z: 1 }, drag = null;

/* Theme initialization */
const savedTheme = localStorage.getItem('dn_theme') || 'light';
R.dataset.theme = savedTheme;
let dark = (savedTheme === 'dark');
function applyTheme(isDark) {
  dark = isDark;
  const theme = dark ? 'dark' : 'light';
  R.dataset.theme = theme;
  localStorage.setItem('dn_theme', theme);
  $('#btn-theme').textContent = dark ? '🌙 Theme' : '☀️ Theme';
}
applyTheme(dark);
$('#btn-theme').onclick = () => applyTheme(!dark);

function clean(html) {
  if (typeof DOMPurify !== 'undefined' && DOMPurify.sanitize) {
    return DOMPurify.sanitize(html, {
      ADD_TAGS: ['input'],
      ADD_ATTR: ['checked', 'disabled', 'type', 'data-note', 'data-h']
    });
  }
  return html;
}

function renderMarkdown(text) {
  try {
    if (typeof marked !== 'undefined' && marked.parse) {
      const parsed = marked.parse(String(text).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => {
        return '<a href="#" data-note="' + esc(a.trim()) + '">' + esc(b ? b.trim() : a.trim()) + '</a>';
      }));
      return clean(parsed);
    }
  } catch (e) {}
  return '<pre>' + esc(text) + '</pre>';
}

function updatePreview() {
  if (!curFile || curFile.type !== 'md') return;
  pvEl.innerHTML = renderMarkdown(curFile.content || '');
}

function setViewMode(mode) {
  B.dataset.mode = mode;
  const btn = $('#btn-view-mode');
  if (mode === 'edit') {
    btn.textContent = '📖 Read';
    btn.title = 'Switch to Reading view';
    ed.focus();
  } else {
    btn.textContent = '✏️ Edit';
    btn.title = 'Switch to Editing view';
    updatePreview();
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
  $('#btn-canvas-view').textContent = next === 'board' ? 'JSON' : 'Board';
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

function setSaveBadge(state) {
  badgeEl.className = state;
  if (state === 'saved') badgeEl.textContent = 'Saved';
  else if (state === 'saving') badgeEl.textContent = 'Saving';
  else if (state === 'conflict') badgeEl.textContent = 'Conflict';
  else if (state === 'error') badgeEl.textContent = 'Error';
}

function showModal({ title, desc, buttons }) {
  return new Promise(resolve => {
    const modal = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-desc').textContent = desc;
    const actions = $('#modal-actions');
    actions.innerHTML = '';
    buttons.forEach(btn => {
      const b = document.createElement('button');
      b.textContent = btn.label;
      if (btn.primary) b.className = 'btn-primary';
      b.onclick = () => {
        modal.hidden = true;
        resolve(btn.value);
      };
      actions.appendChild(b);
    });
    modal.hidden = false;
  });
}

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
      if (fileMap.has(curFile.path)) {
        fileMap.get(curFile.path).mtime = newMtime;
      }
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
    if (fresh) {
      curFile.mtime = fresh.mtime;
    }
    curFile.dirty = false;
    ed.value = curFile.content;
    updatePreview();
    setSaveBadge('saved');
    toast('Loaded disk version');
  } else if (action === 'copy') {
    const ext = curFile.type === 'cv' ? '.canvas' : '.md';
    const copyPath = path.replace(new RegExp(`${ext}$`), `-copy-${Date.now()}${ext}`);
    try {
      const createdMtime = await storage.createFile(copyPath);
      // force:true for file just created by create_file
      const newMtime = await storage.writeText(copyPath, curFile.content || '', null, true);
      await reloadTree();
      const entry = fileMap.get(copyPath);
      if (entry) {
        entry.mtime = newMtime;
      }
      await openFile(copyPath);
      toast('Saved as copy');
    } catch (err) {
      setSaveBadge('error');
      toast('Error saving copy: ' + err);
    }
  }
}

async function reloadTree() {
  try {
    rootTree = await storage.listTree();
    fileMap.clear();
    function index(node) {
      if (node.kind === 'file') {
        const isCv = node.name.endsWith('.canvas');
        fileMap.set(node.path, {
          name: node.name,
          path: node.path,
          type: isCv ? 'cv' : 'md',
          mtime: node.mtime,
          content: null,
          dirty: false
        });
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
  const icon = node.name.endsWith('.canvas') ? '◫' : '📄';
  return '<div class="tree-row file-row' + (isAct ? ' active' : '') + '" data-p="' + esc(node.path) + '">' +
    '  <span class="chevron" style="opacity:0">•</span>' +
    '  <span class="icon">' + icon + '</span>' +
    '  <span class="title">' + esc(node.name) + '</span>' +
    '</div>';
}

treeEl.onclick = async e => {
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

async function openFile(path) {
  const f = fileMap.get(path);
  if (!f) return;
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
    updatePreview();
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

async function saveActiveFile() {
  if (!curFile) return;
  // Normal saves send the stored mtime; if unknown, refuse.
  if (typeof curFile.mtime !== 'number' || curFile.mtime <= 0) {
    setSaveBadge('error');
    toast('Save refused: unknown file mtime');
    return;
  }
  setSaveBadge('saving');
  try {
    const newMtime = await storage.writeText(curFile.path, curFile.content || '', curFile.mtime, false);
    // Store the mtime returned by write_text after each save
    curFile.mtime = newMtime;
    if (fileMap.has(curFile.path)) {
      fileMap.get(curFile.path).mtime = newMtime;
    }
    curFile.dirty = false;
    setSaveBadge('saved');
  } catch (err) {
    if (String(err).includes('Conflict')) {
      await showConflictDialog(curFile.path);
    } else {
      setSaveBadge('error');
      toast('Save error: ' + err);
    }
  }
}

function queueSave() {
  if (!curFile) return;
  curFile.dirty = true;
  setSaveBadge('unsaved');
  if (!autosaveEnabled) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveActiveFile, 650);
}

/* Hard Rule 4: External links blocked, show in-app modal */
document.addEventListener('click', async e => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.note) {
    const target = Array.from(fileMap.values()).find(f => f.name.replace(/\.md$/, '') === a.dataset.note);
    if (target) await openFile(target.path);
    else toast('Note not found: ' + a.dataset.note);
  } else if (/^https?:/i.test(a.href)) {
    await showModal({
      title: 'External Link Blocked',
      desc: `Network navigation is disabled in offline mode. Destination:\n${a.href}`,
      buttons: [{ label: 'Dismiss', value: true, primary: true }]
    });
  }
});

/* Canvas implementation (Rule 5: preserves unknown fields) */
function loadCanvas() {
  try {
    const raw = JSON.parse(curFile.content || '{"nodes":[],"edges":[]}');
    D = {
      ...raw,
      nodes: (raw.nodes || []).filter(n => n && n.id),
      edges: (raw.edges || []).filter(e => e && e.fromNode && e.toNode)
    };
  } catch (e) {
    D = { nodes: [], edges: [] };
  }
}

function commitCanvas() {
  if (!curFile) return;
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

function edges() {
  svg.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>' +
    D.edges.map(e => {
      const a = D.nodes.find(n => n.id === e.fromNode), b = D.nodes.find(n => n.id === e.toNode);
      if (!a || !b) return '';
      const [fs, ts] = sides(a, b, e), p = anc(a, fs), q = anc(b, ts);
      if (!p || !q) return '';
      const d = 'M' + p[0] + ' ' + p[1] + 'C' + (p[0] + DX[fs] * 80) + ' ' + (p[1] + DY[fs] * 80) + ' ' + (q[0] + DX[ts] * 80) + ' ' + (q[1] + DY[ts] * 80) + ' ' + q[0] + ' ' + q[1];
      return '<path class="h" data-id="' + esc(e.id) + '" d="' + d + '"/>' +
             '<path class="v' + (e.id === selE ? ' sel' : '') + '" d="' + d + '"' + (e.toEnd === 'none' ? '' : ' marker-end="url(#ah)"') + '/>';
    }).join('');
}

function draw() {
  world.querySelectorAll('.node').forEach(e => e.remove());
  D.nodes.forEach(n => {
    const el = document.createElement('div');
    el.className = 'node ' + n.type + (n.id === sel ? ' sel' : '');
    el.dataset.id = n.id;
    Object.assign(el.style, { left: n.x + 'px', top: n.y + 'px', width: n.width + 'px', height: n.height + 'px' });
    const c = n.color ? (COL[n.color] || n.color) : '';
    if (c) el.style.setProperty('--nc', c);
    el.innerHTML = '<div class="body">' + (n.type === 'text' ? renderMarkdown(n.text || '') : esc(n.label || n.file || n.url || '')) + '</div><i class="hd"></i><i class="rz"></i>';
    world.appendChild(el);
  });
  edges();
}

function view() {
  world.style.transform = 'translate(' + V.x + 'px,' + V.y + 'px) scale(' + V.z + ')';
  vp.style.backgroundSize = 28 * V.z + 'px ' + 28 * V.z + 'px';
  vp.style.backgroundPosition = V.x + 'px ' + V.y + 'px';
}

function updateOutline() {
  if (!curFile) { info$.innerHTML = ''; return; }
  if (curFile.type === 'md') {
    const hs = [...(curFile.content || '').matchAll(/^(#{1,6})\s+(.+)$/gm)];
    info$.innerHTML = '<h3>Outline</h3>' + (hs.length ? hs.map((m, i) => {
      return '<a href="#" data-h="' + i + '" style="padding-left:' + (m[1].length - 1) * 12 + 'px">' + esc(m[2]) + '</a>';
    }).join('') : '<p class="mute">No headings yet.</p>');
  }
}

info$.onclick = e => {
  const a = e.target.closest('[data-h]');
  if (a) {
    e.preventDefault();
    setViewMode('read');
    const h = pvEl.querySelectorAll('h1,h2,h3,h4,h5,h6')[a.dataset.h];
    if (h) h.scrollIntoView({ block: 'start' });
  }
};

window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveActiveFile();
  }
});

ed.oninput = () => {
  if (!curFile) return;
  curFile.content = ed.value;
  updateOutline();
  queueSave();
};

$('#btn-open-dir').onclick = async () => {
  try {
    const rootName = await storage.pickRoot();
    $('#vault-title').textContent = rootName;
    await reloadTree();
    toast('Workspace mounted');
  } catch (err) {
    toast('Folder selection error: ' + err);
  }
};

async function createNewFile(type = 'md') {
  if (!rootTree) {
    toast('Open a workspace folder first');
    return;
  }
  const isCanvas = (type === 'canvas');
  const ext = isCanvas ? '.canvas' : '.md';
  const base = isCanvas ? 'Untitled Canvas' : 'Untitled';
  let name = `${base}${ext}`;
  let count = 1;
  while (fileMap.has(name)) {
    name = `${base} ${count}${ext}`;
    count++;
  }

  try {
    const createdMtime = await storage.createFile(name);
    const initialContent = isCanvas ? '{"nodes":[],"edges":[]}' : '# Untitled\n\n';
    // force:true only for a file just created by create_file
    const newMtime = await storage.writeText(name, initialContent, null, true);
    await reloadTree();
    const entry = fileMap.get(name);
    if (entry) {
      entry.mtime = newMtime;
    }
    await openFile(name);
    setViewMode('edit');
    toast(`Created ${name}`);
  } catch (err) {
    toast('Creation failed: ' + err);
  }
}

const btnNewNote = $('#btn-new-note');
if (btnNewNote) btnNewNote.onclick = () => createNewFile('md');
const btnNewCanvas = $('#btn-new-canvas');
if (btnNewCanvas) btnNewCanvas.onclick = () => createNewFile('canvas');

$('#btn-save').onclick = () => saveActiveFile();
$('#chk-autosave').onchange = e => { autosaveEnabled = e.target.checked; };
$('#btn-toggle-files').onclick = () => { B.classList.toggle('nf'); };
$('#btn-toggle-info').onclick = () => { B.classList.toggle('ni'); };

async function init() {
  await reloadTree();
  await storage.watch(async ({ paths }) => {
    if (curFile && paths.includes(curFile.path)) {
      if (curFile.dirty) {
        await showConflictDialog(curFile.path);
      } else {
        curFile.content = await storage.readText(curFile.path);
        await reloadTree();
        const fresh = fileMap.get(curFile.path);
        if (fresh) {
          curFile.mtime = fresh.mtime;
        }
        ed.value = curFile.content;
        updatePreview();
        updateOutline();
        toast('Updated from disk');
      }
    } else {
      await reloadTree();
    }
  });
}
init();

