// AI Assistant chat — one assistant turn per POST, streamed straight through the HTTP response
// body via plain chunked transfer (res.write()) and consumed on the browser side with a plain
// fetch()+ReadableStream reader (see public/ai-chat-widget.js) — the browser's own streaming-fetch
// engine, not a hand-rolled polling loop or a new SSE endpoint this app has never needed elsewhere.
// No HTML views of its own — every route here is JSON/streamed-text, consumed entirely by the
// floating widget (partials/ai-chat-widget.ejs), which is present on every page instead of a nav
// item pointing at a dedicated page the way this feature originally shipped.
const express = require('express');
const db = require('../db');
const { decrypt } = require('../secretCrypto');
const mcpClient = require('../mcpClient');
const localDataTools = require('../localDataTools');
const llm = require('../llm');
const { recordNotificationEvent } = require('../notifications');
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

// Conversations+miniservers list, as JSON — for the floating chat widget (see
// partials/ai-chat-widget.ejs/public/ai-chat-widget.js), which builds its own list/switcher UI
// client-side entirely (there's no full-page /ai-chat view anymore — the widget IS the feature's
// only surface now, present on every page instead of a nav item pointing at a dedicated one).
router.get('/list.json', asyncHandler(async (req, res) => {
  const conversations = await db.prepare('SELECT * FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC').all(req.user.id);
  const miniservers = await db.prepare('SELECT id, name FROM miniservers WHERE ai_enabled = 1 AND mcp_access_token IS NOT NULL ORDER BY sort_order, id').all();
  res.json({ conversations, miniservers });
}));

router.post('/', asyncHandler(async (req, res) => {
  const miniserverId = req.body.miniserver_id ? Number(req.body.miniserver_id) : null;
  const now = new Date().toISOString();
  const id = await db.insertReturningId(
    'INSERT INTO ai_conversations (user_id, miniserver_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [req.user.id, miniserverId || null, null, now, now]
  );
  res.json({ id });
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  const conversation = await loadOwnConversation(req.params.id, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  await db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(conversation.id);
  res.json({ ok: true });
}));

// Bulk version of the above — the widget's own "Clear all conversations" (see
// public/ai-chat-widget.js), for starting over rather than deleting one at a time. Still scoped to
// req.user.id, same as every other lookup in this file — never touches another user's history.
router.post('/delete-all', asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM ai_conversations WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
}));

router.get('/:id/messages', asyncHandler(async (req, res) => {
  const conversation = await loadOwnConversation(req.params.id, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const since = Number(req.query.since) || 0;
  const messages = await db.prepare('SELECT * FROM ai_messages WHERE conversation_id = ? AND id > ? ORDER BY id').all(conversation.id, since);
  res.json({ messages });
}));

// One assistant turn, streamed. The response body itself IS the stream — no separate polling
// endpoint needed on top of it; see public/ai-chat-widget.js for the fetch()+ReadableStream reader.
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
  // Anthropic needs a real API key to do anything at all; Ollama needs neither one (a bare local
  // instance takes no auth) nor a base_url (the adapter falls back to the standard localhost
  // default) — only `enabled` is universally required.
  const missingConfig = !settings?.enabled || (settings.provider === 'anthropic' && !settings.api_key);
  if (missingConfig) {
    const message = 'The AI Assistant is not configured yet — see Administration > AI Assistant.';
    await db.prepare('UPDATE ai_messages SET content = ?, status = ?, error = ?, created_at = ? WHERE id = ?').run(message, 'error', message, new Date().toISOString(), assistantId);
    res.write(message);
    return res.end();
  }

  const miniserver = conversation.miniserver_id
    ? await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(conversation.miniserver_id)
    : null;
  // Resolved in plain code, before the model ever sees this turn — see localDataTools.js's own
  // tryPrefetch() header comment for why this exists at all (model-driven tool orchestration for
  // this exact "current value of X in room Y" case proved unreliable even with explicit prompting).
  // null whenever the question isn't a confident single-room/single-value match; the model's own
  // tools handle everything else exactly as before.
  const prefetchHint = miniserver ? await localDataTools.tryPrefetch(miniserver, userText).catch(() => null) : null;
  const history = await db.prepare("SELECT role, content FROM ai_messages WHERE conversation_id = ? AND role != 'tool' AND id != ? ORDER BY id").all(conversation.id, assistantId);

  let fullText = '';
  let lastFlushAt = 0;
  // Tracks whether res.write() ever actually failed (the browser navigated away or the connection
  // otherwise dropped mid-turn) — used below to decide whether this reply is worth a Notification
  // Center ping. Not fired on every ordinary reply (that would be noise — the widget already shows
  // it live while someone's actually watching); only when there's real evidence nobody was.
  let clientWentAway = false;
  const flush = () => db.prepare('UPDATE ai_messages SET content = ? WHERE id = ?').run(fullText, assistantId);

  try {
    const { toolCalls } = await llm.runTurn(settings.provider, {
      apiKey: settings.api_key,
      baseUrl: settings.base_url,
      model: settings.model,
      effort: settings.effort,
      system: miniserver
        ? `You can read and, if permitted, control the Loxone Miniserver "${miniserver.name}" via the tools available to you. You have DIRECT ACCESS to these tools right now, in this same turn — when you're missing a piece of information, call the tool that gets it yourself immediately. Never respond by describing, suggesting, or explaining which tool you WOULD call, or asking the user to look something up — that is never an acceptable final answer when a tool call could just get the real value instead. Only fall back to asking the user a clarifying question if a tool call genuinely can't resolve it (e.g. two different rooms/controls match equally well and you can't tell which one they mean).

Never state a number, status, or value you did not literally see in a tool result — do not estimate, assume, or make one up. This matters even more than usual here: a wrong temperature/status can lead to a real, physical wrong decision, and "truncated": true or a result that doesn't contain the field you needed means the data you actually need is NOT in front of you yet — go get it with another, more targeted tool call before answering, in the same turn.

To answer a question about one specific room/control: ALWAYS try local_find + local_state FIRST — they read from LoxSuite's own already-warm cache with no network round trip, versus every control_find/control_state call being a real, measurably slow round trip to the Miniserver. Only reach for control_find/control_state (or any other control_* tool) when local_find found nothing useful, or local_state came back with cached:false for the uuid you need.

Either way, the same shape applies: first call *_find scoped to that room and a relevant word (not control_state on the whole room) to get its exact uuid, then call *_state with that uuid (and state_name if you already know which state you need) to read just that value. Never invent or guess a uuid for *_state yourself (e.g. from a room/state name) — always take it verbatim from a *_find result first. Calling control_state on an entire room at once returns every state of every control in it, sorted alphabetically and capped at a default of 50 rows — the one value asked for is very often past that cutoff and silently missing, which is exactly why a follow-up, narrower tool call is needed rather than answering (or giving up) on an incomplete result.

Once you have the real value, answer directly and concisely with just what was asked, in its reported unit — never describe, transcribe, or summarize a tool result's raw JSON structure back to the user.${prefetchHint ? `\n\n${prefetchHint}` : ''}`
        : 'No Miniserver is connected to this conversation — you can only chat, not read or control anything.',
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      miniserver,
      mcpClient,
      localDataTools,
      maxToolCalls: settings.max_tool_calls_per_turn,
      onToken: (delta) => {
        fullText += delta;
        // Never let a dead response propagate back into the adapter's own streaming loop — every
        // provider adapter calls onToken synchronously from inside its own `for await` consumption
        // of the LLM's stream, so an uncaught throw here (res.write() on a closed connection) would
        // unwind that loop and very plausibly abort the underlying request to the provider too,
        // cutting the reply short mid-answer. Exactly the same "a background job tied to one
        // request's lifetime dies with that request" issue ollamaPullState.js's own comment
        // explains in full — this write is best-effort only; the turn keeps running regardless.
        try {
          res.write(delta);
        } catch {
          clientWentAway = true;
        }
        // Periodic (not per-token) DB flush — so a DIFFERENT page/tab polling this same
        // conversation (see GET /:id/messages) sees live progress too, not just the final content
        // once the whole turn finishes.
        const now = Date.now();
        if (now - lastFlushAt > 500) {
          lastFlushAt = now;
          flush().catch(() => {});
        }
      },
    });
    // created_at gets overwritten here too, not just content/status — it was stamped at INSERT
    // time (right when the turn started, before the LLM even ran), which for an assistant message
    // is "when it started thinking," not "when the reply was actually ready." A chat timestamp
    // should reflect the latter, same as any other chat client's own send/receive display.
    await db.prepare('UPDATE ai_messages SET content = ?, status = ?, tool_calls_json = ?, created_at = ? WHERE id = ?')
      .run(fullText, 'complete', toolCalls.length ? JSON.stringify(toolCalls) : null, new Date().toISOString(), assistantId);
    if (clientWentAway) {
      await recordNotificationEvent(
        { title: 'AI Assistant reply ready', message: (conversation.title || 'Your conversation') + ' has a new reply.', severity: 'info' },
        { eventType: 'ai_chat_reply' }
      ).catch(() => {});
    }
  } catch (err) {
    await flush();
    await db.prepare('UPDATE ai_messages SET status = ?, error = ?, created_at = ? WHERE id = ?').run('error', err.message, new Date().toISOString(), assistantId);
    try { res.write(`\n\n[Error: ${err.message}]`); } catch { /* already gone */ }
  }

  try { res.end(); } catch { /* already gone */ }
}));

module.exports = router;
