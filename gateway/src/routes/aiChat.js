// AI Assistant chat — one assistant turn per POST, streamed straight through the HTTP response
// body via plain chunked transfer (res.write()) and consumed on the browser side with a plain
// fetch()+ReadableStream reader (see public/ai-chat.js) — the browser's own streaming-fetch engine,
// not a hand-rolled polling loop or a new SSE endpoint this app has never needed elsewhere.
const express = require('express');
const db = require('../db');
const { decrypt } = require('../secretCrypto');
const mcpClient = require('../mcpClient');
const llm = require('../llm/anthropic');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

async function loadAiSettings() {
  const settings = await db.prepare('SELECT * FROM ai_settings WHERE id = 1').get();
  return settings ? { ...settings, api_key: decrypt(settings.api_key) } : settings;
}

// Conversations are personal — every lookup is scoped to req.user.id, same as My Dashboards'
// ownership model, so one user can never see or post into another's conversation by guessing an id.
async function loadOwnConversation(id, userId) {
  return db.prepare('SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?').get(id, userId);
}

router.get('/', asyncHandler(async (req, res) => {
  const conversations = await db.prepare('SELECT * FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC').all(req.user.id);
  const miniservers = await db.prepare('SELECT id, name FROM miniservers WHERE ai_enabled = 1 AND mcp_access_token IS NOT NULL ORDER BY sort_order, id').all();
  res.render('ai-chat', { conversations, miniservers, conversation: null, messages: [], error: null });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const conversation = await loadOwnConversation(req.params.id, req.user.id);
  if (!conversation) return res.status(404).send('Conversation not found');
  const conversations = await db.prepare('SELECT * FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC').all(req.user.id);
  const miniservers = await db.prepare('SELECT id, name FROM miniservers WHERE ai_enabled = 1 AND mcp_access_token IS NOT NULL ORDER BY sort_order, id').all();
  const messages = await db.prepare('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY id').all(conversation.id);
  res.render('ai-chat', { conversations, miniservers, conversation, messages, error: null });
}));

router.post('/', asyncHandler(async (req, res) => {
  const miniserverId = req.body.miniserver_id ? Number(req.body.miniserver_id) : null;
  const now = new Date().toISOString();
  const id = await db.insertReturningId(
    'INSERT INTO ai_conversations (user_id, miniserver_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [req.user.id, miniserverId || null, null, now, now]
  );
  res.redirect(`/ai-chat/${id}`);
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  const conversation = await loadOwnConversation(req.params.id, req.user.id);
  if (!conversation) return res.status(404).send('Conversation not found');
  await db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(conversation.id);
  res.redirect('/ai-chat');
}));

router.get('/:id/messages', asyncHandler(async (req, res) => {
  const conversation = await loadOwnConversation(req.params.id, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const since = Number(req.query.since) || 0;
  const messages = await db.prepare('SELECT * FROM ai_messages WHERE conversation_id = ? AND id > ? ORDER BY id').all(conversation.id, since);
  res.json({ messages });
}));

// One assistant turn, streamed. The response body itself IS the stream — no separate polling
// endpoint needed on top of it; see public/ai-chat.js for the fetch()+ReadableStream reader.
router.post('/:id/messages', asyncHandler(async (req, res) => {
  const conversation = await loadOwnConversation(req.params.id, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const userText = (req.body.content || '').trim();
  if (!userText) return res.status(400).json({ error: 'Message required' });

  // Persisted unconditionally, before any precondition (AI configured? Miniserver reachable?) is
  // even checked — otherwise a message typed while the assistant can't run at all (no API key
  // yet, etc.) would only ever have existed in the browser's own optimistic echo, gone the moment
  // the page reloads.
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO ai_messages (conversation_id, role, content, status, created_at) VALUES (?, 'user', ?, 'complete', ?)`)
    .run(conversation.id, userText, now);

  // Title the conversation from its first message — same "derive a label from the content, don't
  // ask for one upfront" pattern as most chat UIs, since asking first would just add a step nobody
  // wants for a quick question.
  if (!conversation.title) {
    await db.prepare('UPDATE ai_conversations SET title = ? WHERE id = ?').run(userText.slice(0, 80), conversation.id);
  }
  await db.prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(now, conversation.id);

  const assistantId = await db.insertReturningId(
    `INSERT INTO ai_messages (conversation_id, role, content, status, created_at) VALUES (?, 'assistant', '', 'streaming', ?)`,
    [conversation.id, new Date().toISOString()]
  );

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');

  const settings = await loadAiSettings();
  if (!settings?.enabled || !settings.api_key) {
    const message = 'The AI Assistant is not configured yet — see Administration > AI Assistant.';
    await db.prepare('UPDATE ai_messages SET content = ?, status = ?, error = ? WHERE id = ?').run(message, 'error', message, assistantId);
    res.write(message);
    return res.end();
  }

  const miniserver = conversation.miniserver_id
    ? await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(conversation.miniserver_id)
    : null;
  const history = await db.prepare("SELECT role, content FROM ai_messages WHERE conversation_id = ? AND role != 'tool' AND id != ? ORDER BY id").all(conversation.id, assistantId);

  let fullText = '';
  const flush = () => db.prepare('UPDATE ai_messages SET content = ? WHERE id = ?').run(fullText, assistantId);

  try {
    const { toolCalls } = await llm.runTurn({
      apiKey: settings.api_key,
      model: settings.model,
      effort: settings.effort,
      system: miniserver
        ? `You can read and, if permitted, control the Loxone Miniserver "${miniserver.name}" via the tools available to you.`
        : 'No Miniserver is connected to this conversation — you can only chat, not read or control anything.',
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      miniserver,
      mcpClient,
      maxToolCalls: settings.max_tool_calls_per_turn,
      onToken: (delta) => {
        fullText += delta;
        res.write(delta);
      },
    });
    await db.prepare('UPDATE ai_messages SET content = ?, status = ?, tool_calls_json = ? WHERE id = ?')
      .run(fullText, 'complete', toolCalls.length ? JSON.stringify(toolCalls) : null, assistantId);
  } catch (err) {
    await flush();
    await db.prepare('UPDATE ai_messages SET status = ?, error = ? WHERE id = ?').run('error', err.message, assistantId);
    res.write(`\n\n[Error: ${err.message}]`);
  }

  res.end();
}));

module.exports = router;
