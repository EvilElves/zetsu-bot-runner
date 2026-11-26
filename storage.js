// GitHub-backed persistent storage for Zetsu Bot v2 (notes/*.md + state.json)
// Uses native Node 22 fetch API — zero external dependencies.

const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_REPO = process.env.GH_REPO || 'EvilElves/zetsu-bot-brain';
const GH_API = `https://api.github.com/repos/${GH_REPO}/contents`;

// In-memory cache of file SHAs to avoid redundant GETs before PUT/DELETE
const shaCache = new Map();

function ghHeaders() {
  return {
    'Authorization': `token ${GH_TOKEN}`,
    'User-Agent': 'Zetsu-Bot-Cloud/2.0',
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };
}

function encodePath(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

async function ghGetFile(filePath) {
  if (!GH_TOKEN) return null;
  try {
    const res = await fetch(`${GH_API}/${encodePath(filePath)}`, { headers: ghHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`[GitHub] GET ${filePath} failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data.sha) shaCache.set(filePath, data.sha);
    const content = Buffer.from(data.content || '', 'base64').toString('utf8');
    return { content, sha: data.sha, name: data.name, path: data.path };
  } catch (err) {
    console.error(`[GitHub] GET ${filePath} error:`, err.message);
    return null;
  }
}

async function ghPutFile(filePath, contentStr, message = 'Zetsu Bot sync') {
  if (!GH_TOKEN) return false;
  try {
    let sha = shaCache.get(filePath);
    if (!sha) {
      const existing = await ghGetFile(filePath);
      if (existing) sha = existing.sha;
    }

    const body = {
      message,
      content: Buffer.from(contentStr, 'utf8').toString('base64')
    };
    if (sha) body.sha = sha;

    let res = await fetch(`${GH_API}/${encodePath(filePath)}`, {
      method: 'PUT',
      headers: ghHeaders(),
      body: JSON.stringify(body)
    });

    // Retry once on 409 SHA conflict by fetching fresh SHA
    if (res.status === 409 || res.status === 422) {
      const fresh = await ghGetFile(filePath);
      if (fresh) body.sha = fresh.sha;
      else delete body.sha;
      res = await fetch(`${GH_API}/${encodePath(filePath)}`, {
        method: 'PUT',
        headers: ghHeaders(),
        body: JSON.stringify(body)
      });
    }

    if (!res.ok) {
      const errTxt = await res.text();
      console.error(`[GitHub] PUT ${filePath} failed: ${res.status} ${errTxt.slice(0, 200)}`);
      return false;
    }
    const data = await res.json();
    if (data.content?.sha) shaCache.set(filePath, data.content.sha);
    return true;
  } catch (err) {
    console.error(`[GitHub] PUT ${filePath} error:`, err.message);
    return false;
  }
}

async function ghDeleteFile(filePath, message = 'Zetsu Bot delete') {
  if (!GH_TOKEN) return false;
  try {
    let sha = shaCache.get(filePath);
    if (!sha) {
      const existing = await ghGetFile(filePath);
      if (!existing) return false;
      sha = existing.sha;
    }
    const res = await fetch(`${GH_API}/${encodePath(filePath)}`, {
      method: 'DELETE',
      headers: ghHeaders(),
      body: JSON.stringify({ message, sha })
    });
    if (!res.ok) return false;
    shaCache.delete(filePath);
    return true;
  } catch (err) {
    console.error(`[GitHub] DELETE ${filePath} error:`, err.message);
    return false;
  }
}

async function ghListDir(dirPath) {
  if (!GH_TOKEN) return [];
  try {
    const res = await fetch(`${GH_API}/${encodePath(dirPath)}`, { headers: ghHeaders() });
    if (res.status === 404) return [];
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter(item => item.type === 'file').map(item => ({
      name: item.name,
      path: item.path,
      sha: item.sha,
      size: item.size
    }));
  } catch (err) {
    console.error(`[GitHub] LIST ${dirPath} error:`, err.message);
    return [];
  }
}

// Sanitize note title into a clean Obsidian-compatible filename
function slugifyTitle(title) {
  const clean = (title || 'Без названия')
    .replace(/[\\/:*?"<>|#^\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return (clean || 'Заметка_' + Date.now()) + '.md';
}

function formatNowLocal() {
  const now = new Date();
  const tzOffsetMs = 5 * 60 * 60 * 1000; // UTC+5
  const local = new Date(now.getTime() + tzOffsetMs);
  return local.toISOString().replace('T', ' ').slice(0, 16) + ' (UTC+5)';
}

// High-level Notes API (Obsidian-compatible Markdown in notes/)
async function saveNote({ title, content, tags = [], append = false }) {
  const filename = slugifyTitle(title);
  const filePath = `notes/${filename}`;
  const nowStr = formatNowLocal();

  let finalContent = '';
  const existing = await ghGetFile(filePath);

  if (existing && append) {
    finalContent = existing.content.trimEnd() + `\n\n---\n*Дополнено ${nowStr}:*\n\n${content.trim()}\n`;
  } else {
    const tagList = Array.isArray(tags) && tags.length > 0
      ? tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean)
      : ['zetsu-bot'];
    const yamlTags = tagList.map(t => `  - ${t}`).join('\n');
    finalContent =
      `---\n` +
      `title: "${title.replace(/"/g, '\\"')}"\n` +
      `created: "${nowStr}"\n` +
      `source: "Zetsu Telegram Bot"\n` +
      `tags:\n${yamlTags}\n` +
      `---\n\n` +
      `# ${title}\n\n` +
      `${content.trim()}\n`;
  }

  const ok = await ghPutFile(filePath, finalContent, `${append ? 'Append' : 'Save'} note: ${title}`);
  return { ok, filename, filePath, appended: Boolean(existing && append) };
}

async function listNotes(query = '') {
  const files = await ghListDir('notes');
  const mdFiles = files.filter(f => f.name.endsWith('.md'));
  if (!query || !query.trim()) {
    return mdFiles.map(f => ({
      title: f.name.replace(/\.md$/, ''),
      filename: f.name,
      size: f.size
    }));
  }

  const q = query.trim().toLowerCase();
  const results = [];
  for (const f of mdFiles) {
    const title = f.name.replace(/\.md$/, '');
    if (title.toLowerCase().includes(q)) {
      results.push({ title, filename: f.name, size: f.size, matchedIn: 'title' });
      continue;
    }
    // Also search inside file content (up to 30 notes to stay fast)
    if (mdFiles.length <= 30) {
      const data = await ghGetFile(f.path);
      if (data && data.content.toLowerCase().includes(q)) {
        const idx = data.content.toLowerCase().indexOf(q);
        const snippet = data.content.slice(Math.max(0, idx - 40), Math.min(data.content.length, idx + 120)).replace(/\s+/g, ' ');
        results.push({ title, filename: f.name, size: f.size, matchedIn: 'content', snippet });
      }
    }
  }
  return results;
}

async function readNote(titleOrFilename) {
  const files = await ghListDir('notes');
  const target = (titleOrFilename || '').trim().toLowerCase().replace(/\.md$/, '');
  const exact = files.find(f => f.name.toLowerCase().replace(/\.md$/, '') === target);
  const partial = exact || files.find(f => f.name.toLowerCase().includes(target));
  if (!partial) return null;
  const data = await ghGetFile(partial.path);
  if (!data) return null;
  return {
    title: partial.name.replace(/\.md$/, ''),
    filename: partial.name,
    content: data.content
  };
}

async function deleteNote(titleOrFilename) {
  const files = await ghListDir('notes');
  const target = (titleOrFilename || '').trim().toLowerCase().replace(/\.md$/, '');
  const match = files.find(f => f.name.toLowerCase().replace(/\.md$/, '') === target) ||
                files.find(f => f.name.toLowerCase().includes(target));
  if (!match) return { ok: false, error: 'Заметка не найдена' };
  const ok = await ghDeleteFile(match.path, `Delete note: ${match.name}`);
  return { ok, title: match.name.replace(/\.md$/, '') };
}

// Persistent Bot State (config + reminders + knownUsers)
async function loadState() {
  const data = await ghGetFile('state.json');
  if (!data) return null;
  try {
    return JSON.parse(data.content);
  } catch (e) {
    console.error('[Storage] Failed to parse state.json:', e.message);
    return null;
  }
}

let saveTimer = null;
let pendingState = null;

function saveStateDebounced(stateObj, immediate = false) {
  pendingState = stateObj;
  if (saveTimer) clearTimeout(saveTimer);
  const doSave = async () => {
    const snap = pendingState;
    if (!snap) return;
    await ghPutFile('state.json', JSON.stringify(snap, null, 2), 'Update Zetsu Bot state');
  };
  if (immediate) {
    return doSave();
  }
  saveTimer = setTimeout(doSave, 2000);
}

module.exports = {
  saveNote,
  listNotes,
  readNote,
  deleteNote,
  loadState,
  saveStateDebounced,
  formatNowLocal
};
