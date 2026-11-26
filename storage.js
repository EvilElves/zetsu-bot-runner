// GitHub-backed persistent storage for Zetsu Bot v3.0
// Stores Obsidian Markdown notes (notes/*.md, notes/daily/YYYY-MM-DD.md),
// long-term memory (memory.md), and bot state (state.json) in a private GitHub repo.

const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_REPO = process.env.GH_REPO || 'EvilElves/zetsu-bot-brain';
const GH_API = `https://api.github.com/repos/${GH_REPO}/contents`;
const TZ_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5

const shaCache = new Map();

function ghHeaders() {
  return {
    'Authorization': `token ${GH_TOKEN}`,
    'User-Agent': 'Zetsu-Bot-Cloud/3.0',
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
    if (!res.ok) return null;
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
      console.error(`[GitHub] PUT ${filePath} failed: ${res.status}`);
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
    return [];
  }
}

function getLocalDateParts(ms = Date.now()) {
  const d = new Date(ms + TZ_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    dateStr: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    timeStr: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    fullStr: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (UTC+5)`
  };
}

function slugifyTitle(title) {
  const clean = (title || 'Заметка')
    .replace(/[\\/:*?"<>|#^\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return (clean || 'Заметка_' + Date.now()) + '.md';
}

// ==========================================
// 1. Regular Obsidian Notes (notes/*.md)
// ==========================================
async function saveNote({ title, content, tags = [], append = false }) {
  const filename = slugifyTitle(title);
  const filePath = `notes/${filename}`;
  const { fullStr } = getLocalDateParts();

  let finalContent = '';
  const existing = await ghGetFile(filePath);

  if (existing && append) {
    finalContent = existing.content.trimEnd() + `\n\n---\n*Дополнено ${fullStr}:*\n\n${content.trim()}\n`;
  } else {
    const tagList = Array.isArray(tags) && tags.length > 0
      ? tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean)
      : ['zetsu-bot'];
    const yamlTags = tagList.map(t => `  - ${t}`).join('\n');
    finalContent =
      `---\n` +
      `title: "${title.replace(/"/g, '\\"')}"\n` +
      `created: "${fullStr}"\n` +
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
  const [rootFiles, dailyFiles] = await Promise.all([
    ghListDir('notes'),
    ghListDir('notes/daily')
  ]);
  const allMd = [
    ...rootFiles.filter(f => f.name.endsWith('.md')).map(f => ({ ...f, isDaily: false })),
    ...dailyFiles.filter(f => f.name.endsWith('.md')).map(f => ({ ...f, isDaily: true }))
  ];

  if (!query || !query.trim()) {
    return allMd.map(f => ({
      title: f.isDaily ? `Daily: ${f.name.replace(/\.md$/, '')}` : f.name.replace(/\.md$/, ''),
      path: f.path,
      size: f.size,
      isDaily: f.isDaily
    }));
  }

  const q = query.trim().toLowerCase();
  const results = [];
  for (const f of allMd) {
    const title = f.name.replace(/\.md$/, '');
    if (title.toLowerCase().includes(q)) {
      results.push({ title: f.isDaily ? `Daily: ${title}` : title, path: f.path, matchedIn: 'title' });
      continue;
    }
    if (allMd.length <= 35) {
      const data = await ghGetFile(f.path);
      if (data && data.content.toLowerCase().includes(q)) {
        const idx = data.content.toLowerCase().indexOf(q);
        const snippet = data.content.slice(Math.max(0, idx - 40), Math.min(data.content.length, idx + 120)).replace(/\s+/g, ' ');
        results.push({ title: f.isDaily ? `Daily: ${title}` : title, path: f.path, matchedIn: 'content', snippet });
      }
    }
  }
  return results;
}

async function readNote(titleOrPath) {
  const target = (titleOrPath || '').trim().toLowerCase().replace(/^daily:\s*/i, '').replace(/\.md$/, '');
  const [rootFiles, dailyFiles] = await Promise.all([ghListDir('notes'), ghListDir('notes/daily')]);
  const all = [...rootFiles, ...dailyFiles].filter(f => f.name.endsWith('.md'));
  const match = all.find(f => f.name.toLowerCase().replace(/\.md$/, '') === target || f.path.toLowerCase() === target) ||
                all.find(f => f.name.toLowerCase().includes(target));
  if (!match) return null;
  const data = await ghGetFile(match.path);
  if (!data) return null;
  return { title: match.name.replace(/\.md$/, ''), path: match.path, content: data.content };
}

async function deleteNote(titleOrPath) {
  const target = (titleOrPath || '').trim().toLowerCase().replace(/^daily:\s*/i, '').replace(/\.md$/, '');
  const [rootFiles, dailyFiles] = await Promise.all([ghListDir('notes'), ghListDir('notes/daily')]);
  const all = [...rootFiles, ...dailyFiles].filter(f => f.name.endsWith('.md'));
  const match = all.find(f => f.name.toLowerCase().replace(/\.md$/, '') === target) ||
                all.find(f => f.name.toLowerCase().includes(target));
  if (!match) return { ok: false, error: 'Заметка не найдена' };
  const ok = await ghDeleteFile(match.path, `Delete note: ${match.name}`);
  return { ok, title: match.name.replace(/\.md$/, '') };
}

// ==========================================
// 2. Daily Note Inbox (notes/daily/YYYY-MM-DD.md)
// ==========================================
async function appendDailyNote(entryText, isTask = false) {
  const { dateStr, timeStr } = getLocalDateParts();
  const filePath = `notes/daily/${dateStr}.md`;
  const existing = await ghGetFile(filePath);
  const prefix = isTask ? `- [ ] **${timeStr}** — ` : `- **${timeStr}** — `;
  const line = `${prefix}${entryText.trim()}`;

  let content;
  if (existing) {
    content = existing.content.trimEnd() + '\n' + line + '\n';
  } else {
    content =
      `---\n` +
      `date: "${dateStr}"\n` +
      `tags:\n  - daily\n  - inbox\n` +
      `---\n\n` +
      `# 📆 ${dateStr}\n\n` +
      `${line}\n`;
  }

  const ok = await ghPutFile(filePath, content, `Daily note ${dateStr}`);
  return { ok, dateStr, filePath };
}

// Extract open markdown tasks (- [ ] ...) from recent daily notes & root notes for Morning Briefing
async function getOpenTasks(limit = 10) {
  const tasks = [];
  const dailyFiles = (await ghListDir('notes/daily'))
    .filter(f => f.name.endsWith('.md'))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 5);

  for (const f of dailyFiles) {
    const data = await ghGetFile(f.path);
    if (!data) continue;
    const lines = data.content.split('\n');
    for (const l of lines) {
      const m = l.match(/^\s*-\s*\[\s\]\s+(.+)$/);
      if (m) {
        tasks.push({ source: f.name.replace(/\.md$/, ''), text: m[1].trim() });
        if (tasks.length >= limit) return tasks;
      }
    }
  }
  return tasks;
}

// ==========================================
// 3. Long-Term Memory (memory.md)
// ==========================================
async function loadMemory() {
  const data = await ghGetFile('memory.md');
  return data ? data.content : '';
}

async function saveMemory(newContent, message = 'Update Zetsu memory') {
  return await ghPutFile('memory.md', newContent.trim() + '\n', message);
}

async function rememberFact(fact) {
  const { dateStr } = getLocalDateParts();
  const current = await loadMemory();
  const header = current.trim() ? current.trimEnd() : '# 🧠 Долгосрочная память Zetsu (Факты о DevilVsLife)';
  const updated = `${header}\n- [${dateStr}] ${fact.trim()}\n`;
  const ok = await saveMemory(updated, 'Remember fact');
  return { ok, fact: fact.trim() };
}

async function forgetFact(query) {
  const current = await loadMemory();
  if (!current) return { ok: false, error: 'Память пуста' };
  const q = query.trim().toLowerCase();
  const lines = current.split('\n');
  const kept = lines.filter(l => !l.toLowerCase().includes(q));
  if (kept.length === lines.length) return { ok: false, error: 'Подходящий факт не найден' };
  const ok = await saveMemory(kept.join('\n'), `Forget fact matching: ${query}`);
  return { ok, removedCount: lines.length - kept.length };
}

// ==========================================
// 4. URL Content Fetcher (for link summarization)
// ==========================================
async function fetchUrlText(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ZetsuBot/3.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'
      }
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : url;
    const cleanText = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000);
    return { ok: true, title, url, text: cleanText };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ==========================================
// 5. Bot State (state.json) — saved only when needed
// ==========================================
async function loadState() {
  const data = await ghGetFile('state.json');
  if (!data) return null;
  try {
    return JSON.parse(data.content);
  } catch (e) {
    return null;
  }
}

async function saveStateNow(stateObj) {
  return await ghPutFile('state.json', JSON.stringify(stateObj, null, 2), 'Sync Zetsu Bot v3 state');
}

module.exports = {
  saveNote,
  listNotes,
  readNote,
  deleteNote,
  appendDailyNote,
  getOpenTasks,
  loadMemory,
  rememberFact,
  forgetFact,
  fetchUrlText,
  loadState,
  saveStateNow,
  getLocalDateParts
};
