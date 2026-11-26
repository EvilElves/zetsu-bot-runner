const http = require('http');
const https = require('https');
const storage = require('./storage');

// Crash protection
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason?.stack || reason?.message || reason);
});

const PORT = parseInt(process.env.PORT || '7860', 10);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0', 10);
const TZ_OFFSET_HOURS = 5; // UTC+5 (Almaty / Astana / Yekaterinburg)
const TZ_OFFSET_MS = TZ_OFFSET_HOURS * 60 * 60 * 1000;

// Optional finite cloud runner duration (e.g. --run-minutes=20 for GitHub Actions seamless handoff)
const runMinArg = process.argv.find(a => a.startsWith('--run-minutes='));
const RUN_MINUTES = runMinArg ? parseFloat(runMinArg.split('=')[1]) : 0;
let isShuttingDown = false;

if (!BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN environment variable is missing!');
}

let businessConnectionId = process.env.BUSINESS_CONNECTION_ID || '';
const startedAt = Date.now();
let lastPollOkAt = Date.now();

// Default persistent state (populated from private GitHub state.json on startup)
let state = {
  lastUpdateId: 0,
  businessConnectionId: '',
  adminChatHistory: [],
  config: {
    chat_id: '',
    chat_title: '',
    message_thread_id: null,
    is_running: false,
    mode: 'bot',
    gemini_api_key: process.env.GEMINI_API_KEY || '',
    business_auto_reply: false,
    last_business_chat_id: null,
    last_business_sender_name: '',
    tasks: []
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
  const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+05:00`;
  return `${iso} (${days[d.getUTCDay()]}, UTC+5)`;
}

function persistState(immediate = false) {
  // Never persist raw API keys into GitHub state.json
  state.lastUpdateId = lastUpdateId;
  state.businessConnectionId = businessConnectionId;
  state.adminChatHistory = adminChatHistory.slice(-MAX_ADMIN_HISTORY * 2);
  const safeCopy = JSON.parse(JSON.stringify(state));
  delete safeCopy.config.gemini_api_key;
  return storage.saveStateDebounced(safeCopy, immediate);
}

// ==========================================
// HTTP Health Server (required for HF Docker Space 24/7)
// ==========================================
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      bot: '@zetsukbot',
      version: '2.0.0-cloud',
      uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
      last_poll_ok_ago_sec: Math.floor((Date.now() - lastPollOkAt) / 1000),
      active_reminders: state.reminders.length,
      scheduler_running: state.config.is_running,
      autoreply_enabled: state.config.business_auto_reply,
      local_time: getCurrentLocalISO()
    }, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  log(`HTTP Health server listening on 0.0.0.0:${PORT}`);
});

// ==========================================
// Telegram Bot API Helper
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
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            resolve({ ok: false, error: e.message, raw: d });
          }
        });
      });

      const timeoutMs = (method === 'getUpdates') ? 35000 : 15000;
      timer = setTimeout(() => {
        try { req.destroy(); } catch (_) {}
        resolve({ ok: false, error: 'Socket timeout' });
      }, timeoutMs);

      req.on('error', (err) => {
        if (timer) clearTimeout(timer);
        log(`tgCall error [${method}]: ${err.message}`);
        resolve({ ok: false, error: err.message });
      });

      req.write(postData);
      req.end();
    } catch (err) {
      if (timer) clearTimeout(timer);
      log(`tgCall exception [${method}]: ${err.message}`);
      resolve({ ok: false, error: err.message });
    }
  });
}

function getPersistentKeyboard() {
  return {
    keyboard: [
      [
        { text: '📝 Мои заметки' },
        { text: '⏰ Напоминания' }
      ],
      [
        { text: state.config.business_auto_reply ? '🔕 Выключить автоответчик' : '🔔 Включить автоответчик' },
        { text: state.config.is_running ? '⏸ Отключить Дисплей' : '▶️ Включить Дисплей' }
      ],
      [
        { text: '📊 Статус и Панель' },
        { text: '🚀 Тест отправки' }
      ]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

async function notifyAdmin(text, replyMarkup = null) {
  try {
    return await tgCall('sendMessage', {
      chat_id: ADMIN_ID,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup || getPersistentKeyboard()
    });
  } catch (e) {
    log('Failed to notify admin: ' + e.message);
  }
}

async function sendLongMessage(chatId, text, replyMarkup = null) {
  const CHUNK_SIZE = 3800;
  if (text.length <= CHUNK_SIZE) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup || undefined
    });
  }
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_SIZE) {
      parts.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', CHUNK_SIZE);
    if (splitIdx === -1 || splitIdx < CHUNK_SIZE / 2) splitIdx = CHUNK_SIZE;
    parts.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trim();
  }
  for (let i = 0; i < parts.length; i++) {
    await tgCall('sendMessage', {
      chat_id: chatId,
      text: parts[i],
      reply_markup: (i === parts.length - 1) ? replyMarkup : undefined
    });
  }
}

async function sendAsMe(targetChatId, text) {
  if (!businessConnectionId) {
    return { ok: false, error: 'Business connection не активен' };
  }
  return await tgCall('sendMessage', {
    business_connection_id: businessConnectionId,
    chat_id: targetChatId,
    text
  });
}

// ==========================================
// Gemini AI + Function Calling (Notes & Reminders Tools)
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
      description: 'Сохраняет или дополняет личную заметку пользователя в облачное хранилище (Obsidian-совместимый Markdown). Вызывай, когда пользователь просит записать, сохранить, запомнить заметку, идею, список, рецепт или мысль.',
      parameters: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'Короткий понятный заголовок заметки (без .md)' },
          content: { type: 'STRING', description: 'Содержимое заметки в Markdown' },
          tags: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Необязательные теги без символа # (например: ["медицина", "идея", "личное"])'
          },
          append: {
            type: 'BOOLEAN',
            description: 'true — если нужно дописать в существующую заметку с таким же заголовком, false — создать новую или перезаписать'
          }
        },
        required: ['title', 'content']
      }
    },
    {
      name: 'search_notes',
      description: 'Ищет или показывает список всех сохраненных заметок пользователя.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'Поисковый запрос (пустая строка — показать все заметки)' }
        }
      }
    },
    {
      name: 'read_note',
      description: 'Читает полное содержимое конкретной заметки по заголовку.',
      parameters: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'Название заметки' }
        },
        required: ['title']
      }
    },
    {
      name: 'delete_note',
      description: 'Удаляет заметку по названию (только если пользователь явно попросил удалить).',
      parameters: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'Название заметки для удаления' }
        },
        required: ['title']
      }
    },
    {
      name: 'create_reminder',
      description: 'Создаёт уведомление / напоминание, которое бот автоматически пришлёт пользователю в Telegram в указанное время (работает 24/7 без ноутбука).',
      parameters: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING', description: 'Текст напоминания' },
          trigger_at_iso: {
            type: 'STRING',
            description: 'Точная дата и время срабатывания в формате ISO-8601 с часовым поясом +05:00 (например: "2026-11-27T09:00:00+05:00")'
          },
          repeat: {
            type: 'STRING',
            enum: ['none', 'hourly', 'daily', 'weekly'],
            description: 'Повторение: none (один раз), hourly (каждый час), daily (каждый день), weekly (каждую неделю)'
          }
        },
        required: ['text', 'trigger_at_iso']
      }
    },
    {
      name: 'list_reminders',
      description: 'Показывает список всех активных напоминаний пользователя.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'delete_reminder',
      description: 'Удаляет/отменяет напоминание по его ID.',
      parameters: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING', description: 'ID напоминания' }
        },
        required: ['id']
      }
    }
  ]
}];

async function executeToolCall(name, args = {}) {
  log(`[AI Tool] ${name}(${JSON.stringify(args)})`);
  try {
    if (name === 'save_note') {
      const res = await storage.saveNote({
        title: args.title || 'Заметка',
        content: args.content || '',
        tags: args.tags || [],
        append: Boolean(args.append)
      });
      return res.ok
        ? { ok: true, message: `Заметка «${args.title}» сохранена в облако (${res.filePath})`, appended: res.appended }
        : { ok: false, error: 'Не удалось сохранить заметку в GitHub' };
    }

    if (name === 'search_notes') {
      const list = await storage.listNotes(args.query || '');
      return { ok: true, count: list.length, notes: list };
    }

    if (name === 'read_note') {
      const note = await storage.readNote(args.title || '');
      return note ? { ok: true, note } : { ok: false, error: 'Заметка не найдена' };
    }

    if (name === 'delete_note') {
      return await storage.deleteNote(args.title || '');
    }

    if (name === 'create_reminder') {
      const ms = Date.parse(args.trigger_at_iso);
      if (isNaN(ms)) {
        return { ok: false, error: `Некорректный формат даты: ${args.trigger_at_iso}` };
      }
      const id = 'rem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const reminder = {
        id,
        text: String(args.text || 'Напоминание').trim(),
        triggerAtMs: ms,
        repeat: ['hourly', 'daily', 'weekly'].includes(args.repeat) ? args.repeat : 'none',
        createdAtMs: Date.now()
      };
      state.reminders.push(reminder);
      await persistState(true);
      return {
        ok: true,
        id,
        scheduled_for: formatLocalDateTime(ms),
        repeat: reminder.repeat,
        text: reminder.text
      };
    }

    if (name === 'list_reminders') {
      const sorted = [...state.reminders].sort((a, b) => a.triggerAtMs - b.triggerAtMs);
      return {
        ok: true,
        count: sorted.length,
        reminders: sorted.map(r => ({
          id: r.id,
          text: r.text,
          time: formatLocalDateTime(r.triggerAtMs),
          repeat: r.repeat
        }))
      };
    }

    if (name === 'delete_reminder') {
      const before = state.reminders.length;
      state.reminders = state.reminders.filter(r => r.id !== args.id);
      if (state.reminders.length === before) {
        return { ok: false, error: 'Напоминание с таким ID не найдено' };
      }
      await persistState(true);
      return { ok: true, deleted_id: args.id };
    }

    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (err) {
    log(`[AI Tool Error] ${name}: ${err.message}`);
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
        timeout: 25000,
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
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        });
      });
      req.on('error', err => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'Таймаут запроса к Gemini' });
      });
      req.write(postData);
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

async function callGeminiWithFallback(contents, systemText, useTools = false) {
  const apiKey = state.config.gemini_api_key || process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: 'Gemini API key не настроен.' };

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemText }] }
  };
  if (useTools) body.tools = ZETSU_TOOLS;

  let lastError = '';
  for (const model of GEMINI_MODELS) {
    const res = await queryGeminiRaw(model, body, apiKey);
    if (res.ok) return res;
    log(`Gemini [${model}] error (${res.code || '?'}): ${res.error}`);
    lastError = res.error;
  }
  return { ok: false, error: lastError || 'Все модели Gemini временно недоступны.' };
}

// Agentic AI loop for Admin (supports tool calling for Notes & Reminders)
let adminChatHistory = [];
const MAX_ADMIN_HISTORY = 12;

async function askZetsuAgent(userMessage) {
  const systemText =
    `Ты — Zetsu v2.0, облачный 24/7 клинический, технический и персональный ИИ-ассистент DevilVsLife.\n` +
    `Текущее локальное время пользователя: ${getCurrentLocalISO()}.\n\n` +
    `У тебя есть встроенные инструменты (tools):\n` +
    `- save_note / search_notes / read_note / delete_note — работа с личными Obsidian-заметками пользователя в облаке (GitHub).\n` +
    `- create_reminder / list_reminders / delete_reminder — установка и управление уведомлениями/напоминаниями в Telegram.\n\n` +
    `Правила:\n` +
    `1. Если пользователь просит что-то записать, сохранить в заметки, запомнить — СРАЗУ вызывай save_note с аккуратным заголовком и структурированным текстом.\n` +
    `2. Если пользователь просит напомнить, разбудить, пнуть, уведомить через N минут/часов, завтра, в конкретное время или регулярно — СРАЗУ вычисли точное время в +05:00 относительно текущего времени и вызови create_reminder.\n` +
    `3. Если пользователь спрашивает про свои заметки или напоминания — вызывай search_notes / read_note / list_reminders.\n` +
    `4. Ты эксперт в доказательной медицине (UpToDate, Lexicomp, клинические протоколы МЗ РК, ЭКГ, фармакотерапия) и программировании.\n` +
    `5. Отвечай живо, четко, емко и по делу, удобно для чтения в Telegram.`;

  adminChatHistory.push({ role: 'user', parts: [{ text: userMessage }] });
  if (adminChatHistory.length > MAX_ADMIN_HISTORY * 2) {
    adminChatHistory = adminChatHistory.slice(-MAX_ADMIN_HISTORY * 2);
  }

  // Working copy of turns for multi-step tool calling
  const workingContents = [...adminChatHistory];

  for (let step = 0; step < 5; step++) {
    const res = await callGeminiWithFallback(workingContents, systemText, true);
    if (!res.ok) {
      adminChatHistory.pop();
      return { ok: false, error: res.error };
    }

    const parts = res.content.parts || [];
    const fnCalls = parts.filter(p => p.functionCall);

    if (fnCalls.length === 0) {
      const textReply = parts.map(p => p.text || '').join('\n').trim() || 'Готово!';
      adminChatHistory.push({ role: 'model', parts: [{ text: textReply }] });
      return { ok: true, text: textReply, model: res.model };
    }

    // Add model's tool call turn
    workingContents.push(res.content);

    // Execute all requested tool calls and return functionResponse parts
    const responseParts = [];
    for (const fcPart of fnCalls) {
      const { name, args } = fcPart.functionCall;
      const toolResult = await executeToolCall(name, args);
      responseParts.push({
        functionResponse: {
          name,
          response: toolResult
        }
      });
    }
    workingContents.push({ role: 'user', parts: responseParts });
  }

  adminChatHistory.pop();
  return { ok: false, error: 'Превышен лимит шагов агента.' };
}

// Simple Gemini query for Business Auto-Reply (no private tools exposed to strangers!)
async function askGeminiSimple(promptText, systemText) {
  const contents = [{ role: 'user', parts: [{ text: promptText }] }];
  const res = await callGeminiWithFallback(contents, systemText, false);
  if (!res.ok) return res;
  const text = (res.content.parts || []).map(p => p.text || '').join('\n').trim();
  return { ok: true, text, model: res.model };
}

// ==========================================
// Reminder Engine (24/7 Cloud Loop)
// ==========================================
function advanceRepeatTime(triggerAtMs, repeat) {
  const now = Date.now();
  let stepMs = 0;
  if (repeat === 'hourly') stepMs = 60 * 60 * 1000;
  else if (repeat === 'daily') stepMs = 24 * 60 * 60 * 1000;
  else if (repeat === 'weekly') stepMs = 7 * 24 * 60 * 60 * 1000;
  if (!stepMs) return null;
  let next = triggerAtMs + stepMs;
  while (next <= now) next += stepMs;
  return next;
}

async function checkReminders() {
  if (!state.reminders || state.reminders.length === 0) return;
  const now = Date.now();
  let changed = false;
  const remaining = [];

  for (const r of state.reminders) {
    if (now >= r.triggerAtMs) {
      changed = true;
      const repeatLabel = {
        none: 'Разовое',
        hourly: 'Каждый час',
        daily: 'Ежедневно',
        weekly: 'Еженедельно'
      }[r.repeat] || 'Разовое';

      const inlineKb = {
        inline_keyboard: [[
          { text: '✅ Понял', callback_data: `rem_ack_${r.id}` },
          { text: '⏰ +15 мин', callback_data: `rem_snooze15_${r.id}` },
          { text: '⏰ +1 час', callback_data: `rem_snooze60_${r.id}` }
        ]]
      };

      log(`[Reminder Fired] ${r.id}: ${r.text}`);
      await notifyAdmin(
        `⏰ <b>Напоминание от Zetsu!</b>\n\n` +
        `📌 ${escapeHtml(r.text)}\n\n` +
        `🕒 <i>${formatLocalDateTime(now)} • ${repeatLabel}</i>`,
        inlineKb
      );

      if (r.repeat && r.repeat !== 'none') {
        const nextMs = advanceRepeatTime(r.triggerAtMs, r.repeat);
        if (nextMs) {
          r.triggerAtMs = nextMs;
          remaining.push(r);
        }
      }
    } else {
      remaining.push(r);
    }
  }

  if (changed) {
    state.reminders = remaining;
    await persistState(true);
  }
}

setInterval(checkReminders, 15000);

// ==========================================
// Scheduled Tasks (Diceplay / Kotya)
// ==========================================
async function executeTask(task) {
  if (!state.config.is_running || !task.enabled || !state.config.chat_id) return false;
  log(`[Task ${task.name}] Sending "${task.command_text}" to ${state.config.chat_id} (topic: ${state.config.message_thread_id})`);
  const payload = {
    chat_id: state.config.chat_id,
    text: task.command_text
  };
  if (state.config.message_thread_id) payload.message_thread_id = state.config.message_thread_id;

  const res = await tgCall('sendMessage', payload);
  if (res.ok) {
    task.last_sent_timestamp = Date.now();
    task.total_sent_count = (task.total_sent_count || 0) + 1;
    persistState();
    return true;
  }
  log(`[Task ${task.name}] Error: ${res.description || res.error}`);
  return false;
}

let taskTimers = {};
function startAllTimers() {
  for (const tid of Object.keys(taskTimers)) clearInterval(taskTimers[tid]);
  taskTimers = {};
  if (!state.config.is_running) return;
  for (const task of state.config.tasks) {
    if (task.enabled && task.interval_minutes > 0) {
      taskTimers[task.id] = setInterval(() => executeTask(task), task.interval_minutes * 60 * 1000);
    }
  }
}

// ==========================================
// UI Panels (Status, Notes, Reminders)
// ==========================================
function getControlPanelPayload() {
  const schedStatus = state.config.is_running ? '🟢 ВКЛ (каждые 10 мин)' : '🔴 ВЫКЛЮЧЕНА';
  const replyStatus = state.config.business_auto_reply ? '🟢 ВКЛ (Gemini AI)' : '⚪ ВЫКЛЮЧЕН';
  const uptimeMin = Math.floor((Date.now() - startedAt) / 60000);

  const text =
    `🎛 <b>Панель управления Zetsu Bot v2.0 (Cloud 24/7)</b>\n\n` +
    `☁️ <b>Хостинг:</b> GitHub Actions Cloud 24/7 (без ноутбука, смена ${uptimeMin} мин)\n` +
    `📝 <b>Облачные заметки:</b> GitHub Obsidian Sync (приватный репо)\n` +
    `⏰ <b>Активных напоминаний:</b> ${state.reminders.length}\n` +
    `💬 <b>ИИ-автоответчик секретаря:</b> ${replyStatus}\n` +
    `🎮 <b>Автоотправка «Дисплей» (/diceplay, котя):</b> ${schedStatus}\n` +
    `📁 <b>Чат ветки:</b> <code>${state.config.chat_id || 'не задан'}</code> (топик: <code>${state.config.message_thread_id || '—'}</code>)\n` +
    `👤 <b>Последний контакт:</b> ${escapeHtml(state.config.last_business_sender_name || 'нет')} (<code>${state.config.last_business_chat_id || '—'}</code>)\n\n` +
    `💡 <i>Просто напишите мне обычным текстом: «Запиши заметку...» или «Напомни завтра в 9:00...» — я всё сделаю сам!</i>`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: state.config.business_auto_reply ? '🔕 Выкл автоответчик' : '🔔 Вкл автоответчик', callback_data: 'toggle_autoreply' },
        { text: state.config.is_running ? '⏸ Выкл Дисплей' : '▶️ Вкл Дисплей', callback_data: 'toggle_scheduler' }
      ],
      [
        { text: '📝 Заметки', callback_data: 'show_notes' },
        { text: '⏰ Напоминания', callback_data: 'show_reminders' }
      ],
      [
        { text: '🚀 Тест отправки', callback_data: 'send_now' },
        { text: '🔄 Обновить', callback_data: 'refresh' }
      ]
    ]
  };
  return { text, inlineKeyboard };
}

async function sendNotesList() {
  const notes = await storage.listNotes('');
  if (notes.length === 0) {
    return notifyAdmin(
      `📝 <b>Ваши облачные заметки</b>\n\n` +
      `Пока пусто. Просто напишите мне в чат:\n` +
      `<i>«Запиши заметку: купить новый стетоскоп и повторить ЭКГ»</i>`
    );
  }
  const lines = notes.slice(0, 30).map((n, i) => `${i + 1}. <b>${escapeHtml(n.title)}</b>`);
  return notifyAdmin(
    `📝 <b>Ваши облачные заметки (${notes.length}):</b>\n\n` +
    lines.join('\n') +
    `\n\n<i>Напишите «Прочитай заметку &lt;название&gt;» или «Дополни заметку...» — я открою или обновлю её.</i>`
  );
}

async function sendRemindersList() {
  if (state.reminders.length === 0) {
    return notifyAdmin(
      `⏰ <b>Активные напоминания</b>\n\n` +
      `Нет запланированных уведомлений.\n` +
      `Напишите, например: <i>«Напомни через 20 минут выключить чайник»</i> или <i>«Напоминай каждый день в 21:00 выпить витамины»</i>.`
    );
  }
  const sorted = [...state.reminders].sort((a, b) => a.triggerAtMs - b.triggerAtMs);
  const repeatMap = { none: '', hourly: ' 🔁 каждый час', daily: ' 🔁 ежедневно', weekly: ' 🔁 еженедельно' };
  const lines = sorted.map((r, i) =>
    `${i + 1}. <b>${formatLocalDateTime(r.triggerAtMs)}</b>${repeatMap[r.repeat] || ''}\n` +
    `   📌 ${escapeHtml(r.text)} <code>[${r.id}]</code>`
  );
  return notifyAdmin(
    `⏰ <b>Активные напоминания (${sorted.length}):</b>\n\n` +
    lines.join('\n\n') +
    `\n\n<i>Чтобы отменить, напишите: «Удали напоминание &lt;текст или ID&gt;»</i>`
  );
}

// ==========================================
// Handlers (Business, Callback, Message)
// ==========================================
function parseTelegramLink(str) {
  const m1 = str.match(/t\.me\/c\/(\d+)\/(\d+)\/(\d+)/);
  if (m1) return { chat_id: '-100' + m1[1], message_thread_id: parseInt(m1[2], 10) };
  const m2 = str.match(/t\.me\/c\/(\d+)\/(\d+)/);
  if (m2) return { chat_id: '-100' + m2[1], message_thread_id: parseInt(m2[2], 10) };
  const m3 = str.match(/t\.me\/([a-zA-Z0-9_]+)\/(\d+)\/(\d+)/);
  if (m3) return { chat_id: '@' + m3[1], message_thread_id: parseInt(m3[2], 10) };
  return null;
}

async function handleBusinessMessage(msg) {
  const senderId = msg.from?.id;
  if (senderId === ADMIN_ID) return;
  const senderName = ((msg.from?.first_name || '') + ' ' + (msg.from?.last_name || '') + (msg.from?.username ? ` (@${msg.from.username})` : '')).trim();
  const senderChatId = msg.chat?.id;
  const incomingText = msg.text || '[медиа/файл]';

  log(`[Business Message] From ${senderName} (${senderChatId}): "${incomingText}"`);
  state.config.last_business_chat_id = senderChatId;
  state.config.last_business_sender_name = senderName;
  if (msg.from?.username) {
    state.knownUsers[msg.from.username.toLowerCase()] = senderChatId;
    state.knownUsers['@' + msg.from.username.toLowerCase()] = senderChatId;
  }
  persistState();

  if (state.config.business_auto_reply && msg.text) {
    const aiPrompt =
      `Собеседник ${senderName} написал личное сообщение: "${incomingText}".\n` +
      `Ответь кратко (1-3 предложения), живо и естественно от лица ассистента DevilVsLife. Зеркалируй тон собеседника.`;
    const sysPrompt = 'Ты — остроумный и живой персональный ассистент DevilVsLife. Никаких шаблонных фраз робота.';
    const aiRes = await askGeminiSimple(aiPrompt, sysPrompt);
    if (aiRes.ok) {
      const replyRes = await sendAsMe(senderChatId, aiRes.text);
      if (replyRes.ok) {
        return notifyAdmin(
          `🤖 <b>Секретарь Zetsu ответил от вашего имени!</b>\n\n` +
          `👤 <b>Кому:</b> ${escapeHtml(senderName)} (ID: <code>${senderChatId}</code>)\n` +
          `💬 <b>Входящее:</b> ${escapeHtml(incomingText)}\n` +
          `✍️ <b>Ответ:</b>\n${escapeHtml(aiRes.text)}`
        );
      }
    }
  }

  notifyAdmin(
    `📩 <b>Новое сообщение в ваш личный профиль!</b>\n\n` +
    `👤 <b>От:</b> ${escapeHtml(senderName)}\n` +
    `🆔 <b>ID чата:</b> <code>${senderChatId}</code>\n` +
    `💬 <b>Текст:</b> ${escapeHtml(incomingText)}\n\n` +
    `<i>Ответить от своего имени:</i> <code>/say текст ответа</code>`
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

  // Reminder snooze / ack buttons
  if (data.startsWith('rem_ack_')) {
    await tgCall('answerCallbackQuery', { callback_query_id: cbId, text: '✅ Отмечено!' });
    if (msgId && chatId) {
      await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    }
    return;
  }
  if (data.startsWith('rem_snooze15_') || data.startsWith('rem_snooze60_')) {
    const mins = data.startsWith('rem_snooze15_') ? 15 : 60;
    const origText = (cb.message?.text || '').split('\n').find(l => l.startsWith('📌'))?.replace('📌', '').trim() || 'Напоминание';
    const newId = 'rem_' + Date.now().toString(36);
    const nextMs = Date.now() + mins * 60 * 1000;
    state.reminders.push({ id: newId, text: origText, triggerAtMs: nextMs, repeat: 'none', createdAtMs: Date.now() });
    await persistState(true);
    await tgCall('answerCallbackQuery', { callback_query_id: cbId, text: `⏰ Отложено на ${mins} мин!` });
    if (msgId && chatId) {
      await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    }
    return notifyAdmin(`⏰ Отложил напоминание «${escapeHtml(origText)}» на <b>${formatLocalDateTime(nextMs)}</b>.`);
  }

  if (data === 'show_notes') {
    await tgCall('answerCallbackQuery', { callback_query_id: cbId, text: 'Загружаю заметки...' });
    return sendNotesList();
  }
  if (data === 'show_reminders') {
    await tgCall('answerCallbackQuery', { callback_query_id: cbId, text: 'Загружаю напоминания...' });
    return sendRemindersList();
  }

  let toast = '';
  if (data === 'toggle_scheduler') {
    state.config.is_running = !state.config.is_running;
    persistState(true);
    startAllTimers();
    toast = state.config.is_running ? '🟢 Дисплей ВКЛЮЧЕН!' : '🔴 Дисплей ОТКЛЮЧЕН!';
  } else if (data === 'toggle_autoreply') {
    state.config.business_auto_reply = !state.config.business_auto_reply;
    persistState(true);
    toast = state.config.business_auto_reply ? '🟢 Автоответчик ВКЛЮЧЕН!' : '⚪ Автоответчик ОТКЛЮЧЕН!';
  } else if (data === 'send_now') {
    for (const t of state.config.tasks) await executeTask(t);
    toast = '🚀 Команды отправлены!';
  } else if (data === 'refresh') {
    toast = '🔄 Статус обновлён';
  }

  await tgCall('answerCallbackQuery', { callback_query_id: cbId, text: toast });
  if (msgId && chatId) {
    const panel = getControlPanelPayload();
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: msgId,
      text: panel.text,
      parse_mode: 'HTML',
      reply_markup: panel.inlineKeyboard
    });
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const fromId = msg.from?.id;
  let text = (msg.text || '').trim().replace(/^[•\s\-\*]+/, '').trim();
  if (!text) return;

  // Group binding
  if (msg.chat?.type === 'supergroup' || msg.chat?.type === 'group') {
    if (text.startsWith('/setchat') || text.startsWith('/here') || (fromId === ADMIN_ID && text.startsWith('/link'))) {
      state.config.chat_id = String(msg.chat.id);
      state.config.chat_title = msg.chat.title || '';
      if (msg.message_thread_id) state.config.message_thread_id = msg.message_thread_id;
      persistState(true);
      await tgCall('sendMessage', {
        chat_id: msg.chat.id,
        message_thread_id: msg.message_thread_id || undefined,
        text: `✅ Топик «${msg.chat.title || ''}» привязан для Zetsu Cloud Bot!`
      });
      return notifyAdmin(`✅ Группа привязана: ${escapeHtml(state.config.chat_title)} (<code>${state.config.chat_id}</code>)`);
    }
    return;
  }

  // Only ADMIN_ID in private chat
  if (fromId !== ADMIN_ID || msg.chat?.type !== 'private') return;
  const textLower = text.toLowerCase();

  // Business direct start
  if (text.startsWith('/start bizChat')) {
    const numId = parseInt(text.replace('/start bizChat', '').trim(), 10);
    if (!isNaN(numId)) {
      state.config.last_business_chat_id = numId;
      const info = await tgCall('getChat', { chat_id: numId });
      if (info.ok) {
        state.config.last_business_sender_name = info.result.first_name + (info.result.username ? ` (@${info.result.username})` : '');
      }
      persistState(true);
      return notifyAdmin(`👤 Контакт выбран: ${escapeHtml(state.config.last_business_sender_name || numId)} (<code>${numId}</code>)\nОтветить: <code>/say текст</code>`);
    }
  }

  // Paste t.me link
  if (text.includes('t.me/c/') || text.includes('t.me/')) {
    const parsed = parseTelegramLink(text);
    if (parsed) {
      state.config.chat_id = parsed.chat_id;
      if (parsed.message_thread_id) state.config.message_thread_id = parsed.message_thread_id;
      persistState(true);
      return notifyAdmin(`✅ Чат и ветка привязаны: <code>${state.config.chat_id}</code> (топик: <code>${state.config.message_thread_id || 'Основной'}</code>)`);
    }
  }

  // Quick Keyboard & Commands
  if (text === '📝 Мои заметки' || textLower === '/notes' || textLower === 'заметки') {
    return sendNotesList();
  }
  if (text === '⏰ Напоминания' || textLower === '/reminders' || textLower === 'напоминания') {
    return sendRemindersList();
  }
  if (text === '🔕 Выключить автоответчик' || textLower === '/autoreply off' || textLower === 'выключить автоответчик') {
    state.config.business_auto_reply = false;
    persistState(true);
    return notifyAdmin('⚪ <b>ИИ-автоответчик секретаря ВЫКЛЮЧЕН.</b>');
  }
  if (text === '🔔 Включить автоответчик' || textLower === '/autoreply on' || textLower === 'включить автоответчик') {
    state.config.business_auto_reply = true;
    persistState(true);
    return notifyAdmin('🟢 <b>ИИ-автоответчик секретаря ВКЛЮЧЕН!</b>');
  }
  if (text === '⏸ Отключить Дисплей' || textLower === '/stop_auto' || textLower === 'отключить дисплей') {
    state.config.is_running = false;
    persistState(true);
    startAllTimers();
    return notifyAdmin('🔴 <b>Автоотправка «Дисплей» и «Котя» ОТКЛЮЧЕНА.</b>');
  }
  if (text === '▶️ Включить Дисплей' || textLower === '/start_auto' || textLower === 'включить дисплей') {
    state.config.is_running = true;
    persistState(true);
    startAllTimers();
    return notifyAdmin('🟢 <b>Автоотправка «Дисплей» и «Котя» ВКЛЮЧЕНА!</b>');
  }
  if (text === '🚀 Тест отправки' || textLower === '/send_now') {
    notifyAdmin('⏳ Отправляю тестовые команды...');
    for (const t of state.config.tasks) await executeTask(t);
    return notifyAdmin(`✅ Команды отправлены в <code>${state.config.chat_id}</code>.`);
  }
  if (['📊 Статус и Панель', '📊 Статус', 'статус', '/status', '/menu', '/panel', '/start', '/help'].includes(textLower) || text === '📊 Статус и Панель') {
    const panel = getControlPanelPayload();
    return notifyAdmin(panel.text, panel.inlineKeyboard);
  }
  if (['/reset', '/clear', 'сброс', 'очистить'].includes(textLower)) {
    adminChatHistory = [];
    return notifyAdmin('🔄 <b>Память диалога очищена!</b>');
  }
  if (text.startsWith('/say ')) {
    const msgText = text.replace('/say ', '').trim();
    if (!msgText || !state.config.last_business_chat_id) return notifyAdmin('⚠️ Формат: <code>/say текст</code>');
    const res = await sendAsMe(state.config.last_business_chat_id, msgText);
    return res.ok
      ? notifyAdmin(`✅ Отправлено ${escapeHtml(state.config.last_business_sender_name)}: "${escapeHtml(msgText)}"`)
      : notifyAdmin(`❌ Ошибка: ${escapeHtml(res.description || res.error)}`);
  }
  const naturalMatch = text.match(/^(?:ответь|скажи|напиши)\s+([a-zA-Z0-9_а-яА-ЯёЁ@]+)[:\s]+(.+)$/i);
  if (naturalMatch) {
    const targetName = naturalMatch[1].toLowerCase().replace('@', '');
    const replyBody = naturalMatch[2].trim();
    const targetChatId = state.knownUsers[targetName] || state.config.last_business_chat_id;
    if (targetChatId) {
      const res = await sendAsMe(targetChatId, replyBody);
      return res.ok
        ? notifyAdmin(`✅ Отправлено ${escapeHtml(targetName)} (<code>${targetChatId}</code>): "${escapeHtml(replyBody)}"`)
        : notifyAdmin(`❌ Ошибка: ${escapeHtml(res.description || res.error)}`);
    }
  }
  if (text.startsWith('/as_me ')) {
    const parts = text.replace('/as_me ', '').trim().split(' ');
    const target = parts[0];
    const msgText = parts.slice(1).join(' ').trim();
    if (!target || !msgText) return notifyAdmin('⚠️ Формат: <code>/as_me &lt;id_или_@user&gt; &lt;текст&gt;</code>');
    let targetId = state.knownUsers[target.replace('@', '').toLowerCase()] || target;
    const res = await sendAsMe(targetId, msgText);
    return res.ok
      ? notifyAdmin(`✅ Отправлено <code>${escapeHtml(targetId)}</code>: "${escapeHtml(msgText)}"`)
      : notifyAdmin(`❌ Ошибка: ${escapeHtml(res.description || res.error)}`);
  }
  if (text.startsWith('/setkey ')) {
    const newKey = text.replace('/setkey ', '').trim();
    if (newKey) {
      state.config.gemini_api_key = newKey;
      return notifyAdmin('✅ Ключ Gemini API обновлён в текущей сессии.');
    }
  }
  if (text.startsWith('/settopic ')) {
    const val = parseInt(text.replace('/settopic ', '').trim(), 10);
    if (!isNaN(val) && val >= 0) {
      state.config.message_thread_id = val === 0 ? null : val;
      persistState(true);
      return notifyAdmin(`✅ Топик установлен: <code>${state.config.message_thread_id || 'Основной'}</code>`);
    }
  }

  // All other messages (including /note, /remind, or natural Russian text) -> Zetsu AI Agent with Tools!
  await tgCall('sendChatAction', { chat_id: chatId, action: 'typing' });
  const aiRes = await askZetsuAgent(text);
  if (aiRes.ok) {
    return await sendLongMessage(chatId, aiRes.text, getPersistentKeyboard());
  } else {
    return notifyAdmin(`⚠️ <b>Ошибка Zetsu AI:</b> <code>${escapeHtml(aiRes.error)}</code>`);
  }
}

// ==========================================
// Telegram Long Polling Loop
// ==========================================
let lastUpdateId = 0;
let isPolling = false;

async function pollUpdates() {
  if (isPolling || isShuttingDown) return;
  isPolling = true;
  let nextDelay = 300;

  try {
    const pollTimeout = isShuttingDown ? 1 : (RUN_MINUTES > 0 ? 15 : 25);
    const res = await tgCall('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: pollTimeout,
      allowed_updates: ['message', 'business_connection', 'business_message', 'channel_post', 'my_chat_member', 'chat_member', 'callback_query']
    });

    if (res.ok && Array.isArray(res.result)) {
      lastPollOkAt = Date.now();
      let hadUpdates = false;
      for (const u of res.result) {
        hadUpdates = true;
        lastUpdateId = u.update_id;
        if (u.business_connection) {
          businessConnectionId = u.business_connection.id;
          log('Updated business_connection_id: ' + businessConnectionId);
        }
        if (u.business_message) await handleBusinessMessage(u.business_message);
        if (u.callback_query) await handleCallbackQuery(u.callback_query);
        if (u.message) await handleMessage(u.message);
      }
      if (hadUpdates) persistState();
    } else if (res.error_code === 409) {
      log('409 Conflict: Another bot instance is polling. Waiting 5s...');
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

  if (!isShuttingDown) {
    setTimeout(pollUpdates, nextDelay);
  }
}

async function gracefulShutdown(reason = 'timer') {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`=== Graceful shutdown (${reason}): persisting state to GitHub... ===`);
  try {
    await checkReminders();
    await persistState(true);
  } catch (e) {
    log('Shutdown persist error: ' + e.message);
  }
  try { server.close(); } catch (_) {}
  log('=== Shutdown complete ===');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==========================================
// Boot sequence
// ==========================================
async function boot() {
  log(`=== Zetsu Bot v2.0 (Cloud 24/7) Booting (runMinutes=${RUN_MINUTES || 'forever'}) ===`);
  const loaded = await storage.loadState();
  if (loaded) {
    if (loaded.lastUpdateId) lastUpdateId = loaded.lastUpdateId;
    if (loaded.businessConnectionId) businessConnectionId = loaded.businessConnectionId;
    if (Array.isArray(loaded.adminChatHistory)) adminChatHistory = loaded.adminChatHistory;
    if (loaded.config) {
      state.config = { ...state.config, ...loaded.config, gemini_api_key: process.env.GEMINI_API_KEY || state.config.gemini_api_key };
    }
    if (loaded.knownUsers) state.knownUsers = { ...state.knownUsers, ...loaded.knownUsers };
    if (Array.isArray(loaded.reminders)) state.reminders = loaded.reminders;
    log(`Loaded state from GitHub: ${state.reminders.length} reminders, lastUpdateId=${lastUpdateId}.`);
  } else {
    log('No existing state.json in GitHub — initializing fresh state.');
    await persistState(true);
  }

  // Run due reminders immediately on boot
  await checkReminders();
  startAllTimers();
  pollUpdates();

  if (RUN_MINUTES > 0) {
    const runMs = Math.max(30000, Math.floor(RUN_MINUTES * 60 * 1000));
    log(`Scheduled graceful handoff exit in ${RUN_MINUTES} minutes.`);
    setTimeout(() => gracefulShutdown('handoff'), runMs);
  }
  log('=== Zetsu Bot v2.0 Ready ===');
}

boot();
