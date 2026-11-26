// Zetsu Bot v3.0 — Autonomous 24/7 Cloud Personal AI Assistant
// Features: Voice (native audio), Vision/PDF (OCR & analysis), Obsidian Notes,
// Daily Note Inbox, URL Summarizer, Long-term Memory, Reminders (UTC+5),
// Morning Briefing, and Telegram Business Secretary.

const https = require('https');
const storage = require('./storage');

process.on('uncaughtException', (err) => console.error('[Uncaught Exception]', err.stack || err.message));
process.on('unhandledRejection', (reason) => console.error('[Unhandled Rejection]', reason?.stack || reason?.message || reason));

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0', 10);
const TZ_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5 (Almaty / Astana)

const runMinArg = process.argv.find(a => a.startsWith('--run-minutes='));
const RUN_MINUTES = runMinArg ? parseFloat(runMinArg.split('=')[1]) : 0;
let isShuttingDown = false;
let stateDirty = false;

let businessConnectionId = process.env.BUSINESS_CONNECTION_ID || '';
let lastUpdateId = 0;
let cachedMemory = '';
let adminChatHistory = [];
const MAX_ADMIN_HISTORY = 12;

// Clean persistent state (no Diceplay/Kotya bloat, no API keys)
let state = {
  lastUpdateId: 0,
  businessConnectionId: '',
  adminChatHistory: [],
  config: {
    business_auto_reply: false,
    morning_briefing_enabled: true,
    morning_briefing_hour: 8,
    morning_briefing_minute: 30,
    last_briefing_date: '',
    last_business_chat_id: null,
    last_business_sender_name: ''
  },
  knownUsers: {},
  reminders: [] // { id, text, triggerAtMs, repeat: 'none'|'hourly'|'daily'|'weekly', createdAtMs }
};

function log(msg) {
  console.log(`${new Date().toISOString()} - ${msg}`);
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatLocalDateTime(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (${days[d.getUTCDay()]})`;
}

function getCurrentLocalISO() {
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  const days = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+05:00 (${days[d.getUTCDay()]}, UTC+5)`;
}

async function flushState(force = false) {
  if (!force && !stateDirty) return;
  state.lastUpdateId = lastUpdateId;
  state.businessConnectionId = businessConnectionId;
  state.adminChatHistory = adminChatHistory.slice(-MAX_ADMIN_HISTORY * 2);
  await storage.saveStateNow(state);
  stateDirty = false;
}

// ==========================================
// Telegram Bot API Helpers + File Download
// ==========================================
function tgCall(method, params = {}) {
  return new Promise((resolve) => {
    let req;
    let timer;
    try {
      const postData = JSON.stringify(params);
      req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if (timer) clearTimeout(timer);
          try { resolve(JSON.parse(d)); }
          catch (e) { resolve({ ok: false, error: e.message }); }
        });
      });
      timer = setTimeout(() => {
        try { req.destroy(); } catch (_) {}
        resolve({ ok: false, error: 'Socket timeout' });
      }, method === 'getUpdates' ? 35000 : 15000);
      req.on('error', err => { if (timer) clearTimeout(timer); resolve({ ok: false, error: err.message }); });
      req.write(postData);
      req.end();
    } catch (err) {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    }
  });
}

async function downloadTelegramFile(fileId) {
  const info = await tgCall('getFile', { file_id: fileId });
  if (!info.ok || !info.result?.file_path) return null;
  if ((info.result.file_size || 0) > 15 * 1024 * 1024) {
    return { error: 'Файл слишком большой (>15 МБ)' };
  }
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const arrBuf = await res.arrayBuffer();
  return {
    base64: Buffer.from(arrBuf).toString('base64'),
    filePath: info.result.file_path
  };
}

// Clean 4-button persistent bottom keyboard
function getPersistentKeyboard() {
  return {
    keyboard: [
      [{ text: '📝 Заметки' }, { text: '⏰ Напоминания' }],
      [{ text: '🧠 Память' }, { text: '⚙️ Панель' }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

async function notifyAdmin(text, replyMarkup = null) {
  return tgCall('sendMessage', {
    chat_id: ADMIN_ID,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup || getPersistentKeyboard()
  });
}

async function sendLongMessage(chatId, text, replyMarkup = null) {
  const CHUNK_SIZE = 3800;
  if (text.length <= CHUNK_SIZE) {
    return tgCall('sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup || undefined });
  }
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= CHUNK_SIZE) {
      return tgCall('sendMessage', { chat_id: chatId, text: rem, reply_markup: replyMarkup || undefined });
    }
    let idx = rem.lastIndexOf('\n', CHUNK_SIZE);
    if (idx === -1 || idx < CHUNK_SIZE / 2) idx = CHUNK_SIZE;
    await tgCall('sendMessage', { chat_id: chatId, text: rem.slice(0, idx) });
    rem = rem.slice(idx).trim();
  }
}

async function sendAsMe(targetChatId, text) {
  if (!businessConnectionId) return { ok: false, error: 'Business connection не активен' };
  return tgCall('sendMessage', { business_connection_id: businessConnectionId, chat_id: targetChatId, text });
}

// ==========================================
// Gemini AI v3 (Multimodal + Native Function Calling)
// ==========================================
const GEMINI_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-3.5-flash'
];

const ZETSU_TOOLS = [{
  functionDeclarations: [
    {
      name: 'save_note',
      description: 'Создаёт или дополняет отдельную заметку в Obsidian (notes/<название>.md). Используй для структурированных заметок, конспектов, списков, статей.',
      parameters: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'Короткий понятный заголовок без .md' },
          content: { type: 'STRING', description: 'Содержимое в Markdown (можно использовать чекбоксы - [ ] и [[ссылки]])' },
          tags: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Теги без #' },
          append: { type: 'BOOLEAN', description: 'true — дописать в существующую заметку' }
        },
        required: ['title', 'content']
      }
    },
    {
      name: 'append_daily_note',
      description: 'Быстро дописывает мысль, задачу, цитату или пересланное сообщение в сегодняшнюю ежедневную заметку (notes/daily/YYYY-MM-DD.md).',
      parameters: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING', description: 'Текст записи' },
          is_task: { type: 'BOOLEAN', description: 'true — оформить как задачу с чекбоксом - [ ]' }
        },
        required: ['text']
      }
    },
    {
      name: 'search_notes',
      description: 'Ищет заметки по ключевому слову или показывает список всех заметок (включая Daily Notes).',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'Поисковый запрос (или пусто для полного списка)' }
        }
      }
    },
    {
      name: 'read_note',
      description: 'Читает полное содержимое заметки по заголовку или дате.',
      parameters: {
        type: 'OBJECT',
        properties: { title: { type: 'STRING' } },
        required: ['title']
      }
    },
    {
      name: 'delete_note',
      description: 'Удаляет заметку (только по явному запросу пользователя).',
      parameters: {
        type: 'OBJECT',
        properties: { title: { type: 'STRING' } },
        required: ['title']
      }
    },
    {
      name: 'create_reminder',
      description: 'Создаёт напоминание в Telegram на точное время (UTC+5).',
      parameters: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING', description: 'Текст напоминания' },
          trigger_at_iso: { type: 'STRING', description: 'Дата/время ISO-8601 с +05:00, напр. 2026-11-27T09:00:00+05:00' },
          repeat: { type: 'STRING', enum: ['none', 'hourly', 'daily', 'weekly'] }
        },
        required: ['text', 'trigger_at_iso']
      }
    },
    {
      name: 'list_reminders',
      description: 'Показывает список активных напоминаний.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'delete_reminder',
      description: 'Удаляет напоминание по ID.',
      parameters: {
        type: 'OBJECT',
        properties: { id: { type: 'STRING' } },
        required: ['id']
      }
    },
    {
      name: 'remember_fact',
      description: 'Запоминает важный долгосрочный факт о пользователе в memory.md (предпочтения, проекты, привычки, важные даты/люди).',
      parameters: {
        type: 'OBJECT',
        properties: { fact: { type: 'STRING', description: 'Краткий чёткий факт для долгосрочной памяти' } },
        required: ['fact']
      }
    },
    {
      name: 'forget_fact',
      description: 'Удаляет устаревший факт из долгосрочной памяти memory.md по ключевому слову.',
      parameters: {
        type: 'OBJECT',
        properties: { query: { type: 'STRING' } },
        required: ['query']
      }
    },
    {
      name: 'fetch_url',
      description: 'Загружает текстовое содержимое веб-страницы по URL для краткого пересказа, анализа или сохранения в заметку.',
      parameters: {
        type: 'OBJECT',
        properties: { url: { type: 'STRING' } },
        required: ['url']
      }
    }
  ]
}];

async function executeToolCall(name, args = {}) {
  log(`[Tool] ${name}(${JSON.stringify(args).slice(0, 180)})`);
  try {
    if (name === 'save_note') {
      const r = await storage.saveNote({
        title: args.title || 'Заметка',
        content: args.content || '',
        tags: args.tags || [],
        append: Boolean(args.append)
      });
      return r.ok ? { ok: true, filePath: r.filePath, appended: r.appended } : { ok: false, error: 'GitHub error' };
    }
    if (name === 'append_daily_note') {
      return await storage.appendDailyNote(args.text || '', Boolean(args.is_task));
    }
    if (name === 'search_notes') {
      const notes = await storage.listNotes(args.query || '');
      return { ok: true, count: notes.length, notes: notes.slice(0, 30) };
    }
    if (name === 'read_note') {
      const note = await storage.readNote(args.title || '');
      return note ? { ok: true, note } : { ok: false, error: 'Не найдено' };
    }
    if (name === 'delete_note') {
      return await storage.deleteNote(args.title || '');
    }
    if (name === 'create_reminder') {
      const ms = Date.parse(args.trigger_at_iso);
      if (isNaN(ms)) return { ok: false, error: `Некорректная дата: ${args.trigger_at_iso}` };
      const id = 'rem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
      const reminder = {
        id,
        text: String(args.text || 'Напоминание').trim(),
        triggerAtMs: ms,
        repeat: ['hourly', 'daily', 'weekly'].includes(args.repeat) ? args.repeat : 'none',
        createdAtMs: Date.now()
      };
      state.reminders.push(reminder);
      stateDirty = true;
      await flushState(true);
      return { ok: true, id, scheduled_for: formatLocalDateTime(ms), repeat: reminder.repeat };
    }
    if (name === 'list_reminders') {
      const sorted = [...state.reminders].sort((a, b) => a.triggerAtMs - b.triggerAtMs);
      return { ok: true, count: sorted.length, reminders: sorted.map(r => ({ id: r.id, text: r.text, time: formatLocalDateTime(r.triggerAtMs), repeat: r.repeat })) };
    }
    if (name === 'delete_reminder') {
      const before = state.reminders.length;
      state.reminders = state.reminders.filter(r => r.id !== args.id);
      if (state.reminders.length === before) return { ok: false, error: 'Напоминание не найдено' };
      stateDirty = true;
      await flushState(true);
      return { ok: true, deleted_id: args.id };
    }
    if (name === 'remember_fact') {
      const r = await storage.rememberFact(args.fact || '');
      if (r.ok) cachedMemory = await storage.loadMemory();
      return r;
    }
    if (name === 'forget_fact') {
      const r = await storage.forgetFact(args.query || '');
      if (r.ok) cachedMemory = await storage.loadMemory();
      return r;
    }
    if (name === 'fetch_url') {
      return await storage.fetchUrlText(args.url || '');
    }
    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function queryGeminiRaw(model, bodyObj, apiKey) {
  return new Promise((resolve) => {
    try {
      const postData = JSON.stringify(bodyObj);
      const req = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
        method: 'POST',
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(d);
            if (json.candidates && json.candidates[0]?.content) {
              resolve({ ok: true, content: json.candidates[0].content, model });
            } else if (json.error) {
              resolve({ ok: false, error: json.error.message, code: json.error.code });
            } else {
              resolve({ ok: false, error: 'Пустой ответ от Gemini' });
            }
          } catch (e) { resolve({ ok: false, error: e.message }); }
        });
      });
      req.on('error', err => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Таймаут Gemini' }); });
      req.write(postData);
      req.end();
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

async function callGeminiWithFallback(contents, systemText, useTools = false) {
  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY не настроен.' };
  const body = { contents, systemInstruction: { parts: [{ text: systemText }] } };
  if (useTools) body.tools = ZETSU_TOOLS;

  let lastError = '';
  for (const model of GEMINI_MODELS) {
    const res = await queryGeminiRaw(model, body, apiKey);
    if (res.ok) return res;
    log(`Gemini [${model}] error: ${res.error}`);
    lastError = res.error;
  }
  return { ok: false, error: lastError || 'Модели Gemini недоступны.' };
}

async function askZetsuAgent(userParts, textSummaryForHistory) {
  const memoryBlock = cachedMemory.trim()
    ? `\n\n--- ДОЛГОСРОЧНАЯ ПАМЯТЬ О ПОЛЬЗОВАТЕЛЕ (memory.md) ---\n${cachedMemory.slice(0, 3000)}\n--- КОНЕЦ ПАМЯТИ ---`
    : '';

  const systemText =
    `Ты — Zetsu v3.0, персональный облачный 24/7 ИИ-ассистент DevilVsLife в Telegram.\n` +
    `Текущее локальное время пользователя: ${getCurrentLocalISO()}.${memoryBlock}\n\n` +
    `Твои инструменты:\n` +
    `- save_note / append_daily_note / search_notes / read_note / delete_note — Obsidian-заметки в приватном облаке.\n` +
    `- create_reminder / list_reminders / delete_reminder — напоминания в Telegram (UTC+5).\n` +
    `- remember_fact / forget_fact — долгосрочная память о пользователе.\n` +
    `- fetch_url — чтение и конспектирование ссылок.\n\n` +
    `Правила поведения:\n` +
    `1. Если пришло голосовое сообщение — сначала кратко передай суть (без слов-паразитов) и СРАЗУ выполни действие (запиши заметку, поставь напоминание или ответь на вопрос).\n` +
    `2. Если пришло фото/документ (анализы, ЭКГ, рецепт, скриншот, PDF) — внимательно разбери содержимое и при необходимости предложи или сразу сохрани в заметку.\n` +
    `3. Если пользователь скинул ссылку — вызови fetch_url, сделай ёмкую выжимку и предложи/сохрани в заметку.\n` +
    `4. Если пользователь просит что-то запомнить о себе надолго — вызови remember_fact.\n` +
    `5. Для быстрых мыслей/дел на сегодня используй append_daily_note; для полноценных тем/конспектов — save_note.\n` +
    `6. Ты силён в доказательной медицине (UpToDate, Lexicomp, протоколы МЗ РК, ЭКГ) и IT. Отвечай чётко, живо и удобно для Telegram.`;

  // Keep lightweight text-only history so binary audio/image buffers never bloat context
  const workingContents = [...adminChatHistory, { role: 'user', parts: userParts }];

  for (let step = 0; step < 5; step++) {
    const res = await callGeminiWithFallback(workingContents, systemText, true);
    if (!res.ok) return { ok: false, error: res.error };

    const parts = res.content.parts || [];
    const fnCalls = parts.filter(p => p.functionCall);

    if (fnCalls.length === 0) {
      const textReply = parts.map(p => p.text || '').join('\n').trim() || 'Готово!';
      adminChatHistory.push({ role: 'user', parts: [{ text: textSummaryForHistory }] });
      adminChatHistory.push({ role: 'model', parts: [{ text: textReply }] });
      if (adminChatHistory.length > MAX_ADMIN_HISTORY * 2) {
        adminChatHistory = adminChatHistory.slice(-MAX_ADMIN_HISTORY * 2);
      }
      return { ok: true, text: textReply, model: res.model };
    }

    workingContents.push(res.content);
    const responseParts = [];
    for (const fcPart of fnCalls) {
      const { name, args } = fcPart.functionCall;
      const toolResult = await executeToolCall(name, args);
      responseParts.push({ functionResponse: { name, response: toolResult } });
    }
    workingContents.push({ role: 'user', parts: responseParts });
  }
  return { ok: false, error: 'Превышен лимит шагов агента.' };
}

// ==========================================
// Reminder Engine + Morning Briefing (08:30 UTC+5)
// ==========================================
function advanceRepeatTime(triggerAtMs, repeat) {
  const now = Date.now();
  const stepMap = { hourly: 3600000, daily: 86400000, weekly: 604800000 };
  const stepMs = stepMap[repeat];
  if (!stepMs) return null;
  let next = triggerAtMs + stepMs;
  while (next <= now) next += stepMs;
  return next;
}

async function checkRemindersAndBriefing() {
  const now = Date.now();

  // 1. Due reminders
  if (state.reminders.length > 0) {
    let changed = false;
    const remaining = [];
    for (const r of state.reminders) {
      if (now >= r.triggerAtMs) {
        changed = true;
        const repeatLabel = { none: 'Разовое', hourly: 'Каждый час', daily: 'Ежедневно', weekly: 'Еженедельно' }[r.repeat] || 'Разовое';
        const inlineKb = {
          inline_keyboard: [[
            { text: '✅ Понял', callback_data: `rem_ack_${r.id}` },
            { text: '⏰ +15 мин', callback_data: `rem_snooze15_${r.id}` },
            { text: '⏰ +1 час', callback_data: `rem_snooze60_${r.id}` }
          ]]
        };
        log(`[Reminder Fired] ${r.id}: ${r.text}`);
        await notifyAdmin(
          `⏰ <b>Напоминание от Zetsu!</b>\n\n📌 ${escapeHtml(r.text)}\n\n🕒 <i>${formatLocalDateTime(now)} • ${repeatLabel}</i>`,
          inlineKb
        );
        if (r.repeat && r.repeat !== 'none') {
          const nextMs = advanceRepeatTime(r.triggerAtMs, r.repeat);
          if (nextMs) { r.triggerAtMs = nextMs; remaining.push(r); }
        }
      } else {
        remaining.push(r);
      }
    }
    if (changed) {
      state.reminders = remaining;
      stateDirty = true;
      await flushState(true);
    }
  }

  // 2. Morning Briefing (once per day after configured hour:minute UTC+5)
  if (state.config.morning_briefing_enabled) {
    const localD = new Date(now + TZ_OFFSET_MS);
    const { dateStr } = storage.getLocalDateParts(now);
    const h = localD.getUTCHours();
    const m = localD.getUTCMinutes();
    const targetH = state.config.morning_briefing_hour ?? 8;
    const targetM = state.config.morning_briefing_minute ?? 30;

    if (state.config.last_briefing_date !== dateStr && (h > targetH || (h === targetH && m >= targetM)) && h < 13) {
      state.config.last_briefing_date = dateStr;
      stateDirty = true;
      await sendMorningBriefing(dateStr);
      await flushState(true);
    }
  }
}

async function sendMorningBriefing(dateStr) {
  const todayStart = Date.parse(`${dateStr}T00:00:00+05:00`);
  const todayEnd = todayStart + 86400000;
  const todayRems = state.reminders
    .filter(r => r.triggerAtMs >= todayStart && r.triggerAtMs < todayEnd)
    .sort((a, b) => a.triggerAtMs - b.triggerAtMs);
  const openTasks = await storage.getOpenTasks(8);

  if (todayRems.length === 0 && openTasks.length === 0) return;

  let msg = `🌅 <b>Утренний брифинг Zetsu (${dateStr})</b>\n\n`;
  if (todayRems.length > 0) {
    msg += `⏰ <b>Напоминания на сегодня:</b>\n` +
      todayRems.map(r => `• <b>${formatLocalDateTime(r.triggerAtMs).slice(11, 16)}</b> — ${escapeHtml(r.text)}`).join('\n') + '\n\n';
  }
  if (openTasks.length > 0) {
    msg += `☑️ <b>Открытые задачи из Daily Notes:</b>\n` +
      openTasks.map(t => `• [${t.source}] ${escapeHtml(t.text)}`).join('\n') + '\n\n';
  }
  msg += `<i>Продуктивного дня! Можете надиктовать голосовым новые дела или мысли.</i>`;
  await notifyAdmin(msg);
}

setInterval(checkRemindersAndBriefing, 15000);

// ==========================================
// UI Panels (Clean & Minimal)
// ==========================================
function getControlPanelPayload() {
  const replyStatus = state.config.business_auto_reply ? '🟢 ВКЛ' : '⚪ ВЫКЛ';
  const briefStatus = state.config.morning_briefing_enabled ? '🟢 ВКЛ (08:30 UTC+5)' : '⚪ ВЫКЛ';

  const text =
    `⚙️ <b>Панель управления Zetsu Bot v3.0</b>\n\n` +
    `☁️ <b>Облако:</b> GitHub Actions 24/7 (без ноутбука)\n` +
    `🎤 <b>Мультимодальность:</b> Голос + Фото/ЭКГ/PDF + Ссылки\n` +
    `⏰ <b>Активных напоминаний:</b> ${state.reminders.length}\n` +
    `🌅 <b>Утренний брифинг:</b> ${briefStatus}\n` +
    `💬 <b>ИИ-секретарь (Business):</b> ${replyStatus}\n` +
    `👤 <b>Последний контакт:</b> ${escapeHtml(state.config.last_business_sender_name || 'нет')}\n\n` +
    `<i>Просто пишите текстом, шлите голосовые, фото или ссылки — я всё обработаю сам.</i>`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: state.config.business_auto_reply ? '🔕 Выкл секретаря' : '🔔 Вкл секретаря', callback_data: 'toggle_autoreply' },
        { text: state.config.morning_briefing_enabled ? '🌅 Выкл брифинг' : '🌅 Вкл брифинг', callback_data: 'toggle_briefing' }
      ],
      [
        { text: '🔄 Сбросить диалог', callback_data: 'reset_chat' },
        { text: '🔄 Обновить', callback_data: 'refresh' }
      ]
    ]
  };
  return { text, inlineKeyboard };
}

async function sendNotesList() {
  const notes = await storage.listNotes('');
  if (notes.length === 0) {
    return notifyAdmin(`📝 <b>Облачные заметки</b>\n\nПока пусто. Надиктуйте голосовое или напишите: <i>«Запиши заметку: ...»</i>`);
  }
  const lines = notes.slice(0, 30).map((n, i) => `${i + 1}. <b>${escapeHtml(n.title)}</b>`);
  return notifyAdmin(
    `📝 <b>Ваши заметки в Obsidian Cloud (${notes.length}):</b>\n\n${lines.join('\n')}\n\n` +
    `<i>Напишите «Прочитай заметку &lt;название&gt;» или просто пришлите мысль/ссылку/голос.</i>`
  );
}

async function sendRemindersList() {
  if (state.reminders.length === 0) {
    return notifyAdmin(`⏰ <b>Напоминания</b>\n\nПусто. Скажите или напишите: <i>«Напомни завтра в 9:00 ...»</i>`);
  }
  const sorted = [...state.reminders].sort((a, b) => a.triggerAtMs - b.triggerAtMs);
  const repMap = { none: '', hourly: ' 🔁 каждый час', daily: ' 🔁 ежедневно', weekly: ' 🔁 еженедельно' };
  const lines = sorted.map((r, i) =>
    `${i + 1}. <b>${formatLocalDateTime(r.triggerAtMs)}</b>${repMap[r.repeat] || ''}\n   📌 ${escapeHtml(r.text)} <code>[${r.id}]</code>`
  );
  return notifyAdmin(`⏰ <b>Активные напоминания (${sorted.length}):</b>\n\n${lines.join('\n\n')}`);
}

async function sendMemoryView() {
  cachedMemory = await storage.loadMemory();
  if (!cachedMemory.trim()) {
    return notifyAdmin(`🧠 <b>Долгосрочная память пуста</b>\n\nНапишите: <i>«Запомни, что я ...»</i> — я сохраню это навсегда в <code>memory.md</code>.`);
  }
  return notifyAdmin(
    `🧠 <b>Долгосрочная память Zetsu:</b>\n\n${escapeHtml(cachedMemory.slice(0, 3500))}\n\n` +
    `<i>Можно сказать «Запомни...» или «Забудь про...».</i>`
  );
}

// ==========================================
// Handlers (Business, Callback, Message)
// ==========================================
async function handleBusinessMessage(msg) {
  const senderId = msg.from?.id;
  if (senderId === ADMIN_ID) return;
  const senderName = ((msg.from?.first_name || '') + ' ' + (msg.from?.last_name || '') + (msg.from?.username ? ` (@${msg.from.username})` : '')).trim();
  const senderChatId = msg.chat?.id;
  const incomingText = msg.text || '[медиа/файл]';

  state.config.last_business_chat_id = senderChatId;
  state.config.last_business_sender_name = senderName;
  if (msg.from?.username) {
    state.knownUsers[msg.from.username.toLowerCase()] = senderChatId;
    state.knownUsers['@' + msg.from.username.toLowerCase()] = senderChatId;
  }
  stateDirty = true;

  if (state.config.business_auto_reply && msg.text) {
    const res = await callGeminiWithFallback(
      [{ role: 'user', parts: [{ text: `Собеседник ${senderName} написал: "${incomingText}". Ответь кратко (1-3 предложения) и живо от лица ассистента DevilVsLife, зеркалируя тон.` }] }],
      'Ты — остроумный и живой персональный ассистент DevilVsLife. Никаких шаблонных фраз робота.',
      false
    );
    if (res.ok) {
      const replyText = (res.content.parts || []).map(p => p.text || '').join('\n').trim();
      const sendRes = await sendAsMe(senderChatId, replyText);
      if (sendRes.ok) {
        return notifyAdmin(
          `🤖 <b>Секретарь ответил ${escapeHtml(senderName)}:</b>\n💬 ${escapeHtml(incomingText)}\n✍️ ${escapeHtml(replyText)}`
        );
      }
    }
  }

  notifyAdmin(
    `📩 <b>Личное сообщение от ${escapeHtml(senderName)}</b> (<code>${senderChatId}</code>):\n\n` +
    `${escapeHtml(incomingText)}\n\n<i>Ответить:</i> <code>/say текст</code>`
  );
}

async function handleCallbackQuery(cb) {
  const data = cb.data || '';
  const cbId = cb.id;
  const msgId = cb.message?.message_id;
  const chatId = cb.message?.chat?.id;

  if (cb.from?.id !== ADMIN_ID) {
    return tgCall('answerCallbackQuery', { callback_query_id: cbId, text: 'Доступ ограничен.' });
  }

  if (data.startsWith('rem_ack_')) {
    await tgCall('answerCallbackQuery', { callback_query_id: cbId, text: '✅ Готово!' });
    if (msgId && chatId) await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    return;
  }
  if (data.startsWith('rem_snooze15_') || data.startsWith('rem_snooze60_')) {
    const mins = data.startsWith('rem_snooze15_') ? 15 : 60;
    const origText = (cb.message?.text || '').split('\n').find(l => l.startsWith('📌'))?.replace('📌', '').trim() || 'Напоминание';
    const nextMs = Date.now() + mins * 60 * 1000;
    state.reminders.push({ id: 'rem_' + Date.now().toString(36), text: origText, triggerAtMs: nextMs, repeat: 'none', createdAtMs: Date.now() });
    stateDirty = true;
    await flushState(true);
    await tgCall('answerCallbackQuery', { callback_query_id: cbId, text: `⏰ Отложено на ${mins} мин` });
    if (msgId && chatId) await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    return notifyAdmin(`⏰ Отложил «${escapeHtml(origText)}» на <b>${formatLocalDateTime(nextMs)}</b>.`);
  }

  let toast = '';
  if (data === 'toggle_autoreply') {
    state.config.business_auto_reply = !state.config.business_auto_reply;
    stateDirty = true;
    await flushState(true);
    toast = state.config.business_auto_reply ? '🟢 Секретарь ВКЛ' : '⚪ Секретарь ВЫКЛ';
  } else if (data === 'toggle_briefing') {
    state.config.morning_briefing_enabled = !state.config.morning_briefing_enabled;
    stateDirty = true;
    await flushState(true);
    toast = state.config.morning_briefing_enabled ? '🟢 Утренний брифинг ВКЛ' : '⚪ Утренний брифинг ВЫКЛ';
  } else if (data === 'reset_chat') {
    adminChatHistory = [];
    toast = '🔄 Контекст диалога очищен';
  } else if (data === 'refresh') {
    toast = '🔄 Обновлено';
  }

  await tgCall('answerCallbackQuery', { callback_query_id: cbId, text: toast });
  if (msgId && chatId) {
    const panel = getControlPanelPayload();
    await tgCall('editMessageText', { chat_id: chatId, message_id: msgId, text: panel.text, parse_mode: 'HTML', reply_markup: panel.inlineKeyboard });
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const fromId = msg.from?.id;
  if (fromId !== ADMIN_ID || msg.chat?.type !== 'private') return;

  const text = (msg.text || msg.caption || '').trim();
  const textLower = text.toLowerCase();

  // Quick 4-button keyboard & commands
  if (text === '📝 Заметки' || textLower === '/notes') return sendNotesList();
  if (text === '⏰ Напоминания' || textLower === '/reminders') return sendRemindersList();
  if (text === '🧠 Память' || textLower === '/memory') return sendMemoryView();
  if (['⚙️ Панель', '/status', '/menu', '/start', '/help'].includes(text) || ['/status', '/menu', '/start', '/help'].includes(textLower)) {
    const panel = getControlPanelPayload();
    return notifyAdmin(panel.text, panel.inlineKeyboard);
  }
  if (['/reset', '/clear', 'сброс'].includes(textLower)) {
    adminChatHistory = [];
    return notifyAdmin('🔄 <b>Контекст диалога очищен!</b> (Долгосрочная память в <code>memory.md</code> сохранена)');
  }

  // Telegram Business quick replies
  if (text.startsWith('/start bizChat')) {
    const numId = parseInt(text.replace('/start bizChat', '').trim(), 10);
    if (!isNaN(numId)) {
      state.config.last_business_chat_id = numId;
      const info = await tgCall('getChat', { chat_id: numId });
      if (info.ok) state.config.last_business_sender_name = info.result.first_name + (info.result.username ? ` (@${info.result.username})` : '');
      stateDirty = true;
      return notifyAdmin(`👤 Контакт выбран: ${escapeHtml(state.config.last_business_sender_name || numId)}\nОтветить: <code>/say текст</code>`);
    }
  }
  if (text.startsWith('/say ')) {
    const msgText = text.replace('/say ', '').trim();
    if (!msgText || !state.config.last_business_chat_id) return notifyAdmin('⚠️ Формат: <code>/say текст</code>');
    const res = await sendAsMe(state.config.last_business_chat_id, msgText);
    return res.ok
      ? notifyAdmin(`✅ Отправлено ${escapeHtml(state.config.last_business_sender_name)}: "${escapeHtml(msgText)}"`)
      : notifyAdmin(`❌ Ошибка: ${escapeHtml(res.description || res.error)}`);
  }
  const natMatch = text.match(/^(?:ответь|скажи|напиши)\s+([a-zA-Z0-9_а-яА-ЯёЁ@]+)[:\s]+(.+)$/i);
  if (natMatch) {
    const targetName = natMatch[1].toLowerCase().replace('@', '');
    const targetChatId = state.knownUsers[targetName] || state.config.last_business_chat_id;
    if (targetChatId) {
      const res = await sendAsMe(targetChatId, natMatch[2].trim());
      return res.ok
        ? notifyAdmin(`✅ Отправлено ${escapeHtml(targetName)}: "${escapeHtml(natMatch[2].trim())}"`)
        : notifyAdmin(`❌ Ошибка: ${escapeHtml(res.description || res.error)}`);
    }
  }
  if (text.startsWith('/as_me ')) {
    const parts = text.replace('/as_me ', '').trim().split(' ');
    const target = parts[0];
    const msgText = parts.slice(1).join(' ').trim();
    if (!target || !msgText) return notifyAdmin('⚠️ Формат: <code>/as_me &lt;id_или_@user&gt; &lt;текст&gt;</code>');
    const targetId = state.knownUsers[target.replace('@', '').toLowerCase()] || target;
    const res = await sendAsMe(targetId, msgText);
    return res.ok
      ? notifyAdmin(`✅ Отправлено <code>${escapeHtml(targetId)}</code>: "${escapeHtml(msgText)}"`)
      : notifyAdmin(`❌ Ошибка: ${escapeHtml(res.description || res.error)}`);
  }

  // Build multimodal Gemini input (Voice / Photo / PDF / Forwarded / Text)
  const userParts = [];
  let historySummary = text;

  // 1. Voice / Audio message
  if (msg.voice || msg.audio) {
    await tgCall('sendChatAction', { chat_id: chatId, action: 'typing' });
    const fileId = msg.voice ? msg.voice.file_id : msg.audio.file_id;
    const mimeType = msg.voice ? 'audio/ogg' : (msg.audio.mime_type || 'audio/mpeg');
    const dl = await downloadTelegramFile(fileId);
    if (!dl || dl.error) return notifyAdmin(`⚠️ Не удалось скачать голосовое: ${dl?.error || 'ошибка Telegram'}`);
    userParts.push({ inlineData: { mimeType, data: dl.base64 } });
    userParts.push({ text: text || 'Прослушай это голосовое сообщение от пользователя и выполни его просьбу (запиши заметку, поставь напоминание, запомни факт или ответь).' });
    historySummary = `[Голосовое сообщение] ${text}`.trim();
  }
  // 2. Photo (Vision / OCR)
  else if (msg.photo && msg.photo.length > 0) {
    await tgCall('sendChatAction', { chat_id: chatId, action: 'typing' });
    const bestPhoto = msg.photo[msg.photo.length - 1];
    const dl = await downloadTelegramFile(bestPhoto.file_id);
    if (!dl || dl.error) return notifyAdmin(`⚠️ Не удалось скачать фото: ${dl?.error || 'ошибка'}`);
    userParts.push({ inlineData: { mimeType: 'image/jpeg', data: dl.base64 } });
    userParts.push({ text: text || 'Проанализируй это изображение (если это текст/анализы/ЭКГ/рецепт — расшифруй и дай чёткую выжимку).' });
    historySummary = `[Фото] ${text}`.trim();
  }
  // 3. Document (PDF or Image file)
  else if (msg.document) {
    const mime = msg.document.mime_type || '';
    if (mime === 'application/pdf' || mime.startsWith('image/')) {
      await tgCall('sendChatAction', { chat_id: chatId, action: 'typing' });
      const dl = await downloadTelegramFile(msg.document.file_id);
      if (!dl || dl.error) return notifyAdmin(`⚠️ Не удалось скачать файл: ${dl?.error || 'ошибка'}`);
      userParts.push({ inlineData: { mimeType: mime, data: dl.base64 } });
      userParts.push({ text: text || `Проанализируй документ «${msg.document.file_name || 'файл'}» и сделай краткую структурированную выжимку.` });
      historySummary = `[Документ: ${msg.document.file_name}] ${text}`.trim();
    } else {
      return notifyAdmin('⚠️ Поддерживаются фото, голосовые и PDF-документы.');
    }
  }
  // 4. Forwarded text message -> hint to save to Daily Note / Inbox
  else if (text) {
    await tgCall('sendChatAction', { chat_id: chatId, action: 'typing' });
    const isForwarded = Boolean(msg.forward_origin || msg.forward_from || msg.forward_from_chat);
    const prompt = isForwarded
      ? `Пользователь переслал сообщение (вероятно, хочет сохранить в Daily Note или разобрать):\n\n${text}`
      : text;
    userParts.push({ text: prompt });
    historySummary = text;
  } else {
    return;
  }

  const aiRes = await askZetsuAgent(userParts, historySummary);
  if (aiRes.ok) {
    return sendLongMessage(chatId, aiRes.text, getPersistentKeyboard());
  }
  return notifyAdmin(`⚠️ <b>Ошибка Zetsu AI:</b> <code>${escapeHtml(aiRes.error)}</code>`);
}

// ==========================================
// Polling Loop & Graceful Shift Handoff
// ==========================================
let isPolling = false;

async function pollUpdates() {
  if (isPolling || isShuttingDown) return;
  isPolling = true;
  let nextDelay = 300;

  try {
    const res = await tgCall('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: isShuttingDown ? 1 : (RUN_MINUTES > 0 ? 15 : 25),
      allowed_updates: ['message', 'business_connection', 'business_message', 'callback_query']
    });

    if (res.ok && Array.isArray(res.result)) {
      for (const u of res.result) {
        lastUpdateId = u.update_id;
        stateDirty = true; // will be saved on graceful shutdown or immediate reminder/setting change
        if (u.business_connection) {
          businessConnectionId = u.business_connection.id;
          log('Updated business_connection_id');
        }
        if (u.business_message) await handleBusinessMessage(u.business_message);
        if (u.callback_query) await handleCallbackQuery(u.callback_query);
        if (u.message) await handleMessage(u.message);
      }
    } else if (res.error_code === 409) {
      log('409 Conflict: waiting 5s for previous shift to exit...');
      nextDelay = 5000;
    } else if (!res.ok) {
      log('getUpdates error: ' + (res.description || res.error));
      nextDelay = 3000;
    }
  } catch (err) {
    log('Polling exception: ' + err.message);
    nextDelay = 3000;
  } finally {
    isPolling = false;
  }

  if (!isShuttingDown) setTimeout(pollUpdates, nextDelay);
}

async function gracefulShutdown(reason = 'handoff') {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`=== Graceful shutdown (${reason}): flushing state if changed ===`);
  try {
    await checkRemindersAndBriefing();
    await flushState(false); // only commits if something actually changed during this shift!
  } catch (e) {
    log('Shutdown flush error: ' + e.message);
  }
  log('=== Shift complete ===');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function boot() {
  log(`=== Zetsu Bot v3.0 (Cloud 24/7) Booting (runMinutes=${RUN_MINUTES || 'forever'}) ===`);
  const [loaded, mem] = await Promise.all([storage.loadState(), storage.loadMemory()]);
  cachedMemory = mem || '';

  if (loaded) {
    if (loaded.lastUpdateId) lastUpdateId = loaded.lastUpdateId;
    if (loaded.businessConnectionId) businessConnectionId = loaded.businessConnectionId;
    if (Array.isArray(loaded.adminChatHistory)) adminChatHistory = loaded.adminChatHistory;
    if (loaded.config) {
      state.config = {
        ...state.config,
        business_auto_reply: Boolean(loaded.config.business_auto_reply),
        morning_briefing_enabled: loaded.config.morning_briefing_enabled ?? true,
        morning_briefing_hour: loaded.config.morning_briefing_hour ?? 8,
        morning_briefing_minute: loaded.config.morning_briefing_minute ?? 30,
        last_briefing_date: loaded.config.last_briefing_date || '',
        last_business_chat_id: loaded.config.last_business_chat_id || null,
        last_business_sender_name: loaded.config.last_business_sender_name || ''
      };
    }
    if (loaded.knownUsers) state.knownUsers = { ...state.knownUsers, ...loaded.knownUsers };
    if (Array.isArray(loaded.reminders)) state.reminders = loaded.reminders;
    log(`Loaded state: ${state.reminders.length} reminders, memory=${cachedMemory.length} chars, lastUpdateId=${lastUpdateId}`);
  } else {
    stateDirty = true;
    await flushState(true);
  }

  await checkRemindersAndBriefing();
  pollUpdates();

  if (RUN_MINUTES > 0) {
    setTimeout(() => gracefulShutdown('handoff'), Math.max(30000, Math.floor(RUN_MINUTES * 60 * 1000)));
  }
  log('=== Zetsu Bot v3.0 Ready ===');
}

boot();
