// Tracks the AI Assistant's own Ollama model pull as a background operation, independent of
// whichever HTTP request happened to start it. The previous shape drove the pull directly inside
// routes/admin.js's own POST /ai/ollama-pull request handler, tied 1:1 to that one browser
// connection: navigating away from Administration > AI Assistant mid-pull disconnected the
// response this was streaming progress into, res.write() on it then throws, which unwinds the
// for-await loop consuming Ollama's own progress stream — and that's the same HTTP request TO
// Ollama the pull itself rides on, so aborting the loop very plausibly aborted the download too.
// A plain module-level EventEmitter instead: startPull() kicks the real pull off once, unawaited by
// any one caller; any number of admin-ai.ejs page loads (the same tab reloaded, a different tab,
// this same admin an hour later) can subscribe() to tail its progress, or just read getState() for
// a snapshot, without any of that affecting whether the pull itself keeps running.
const EventEmitter = require('events');
const { pullModel } = require('./llm/ollama');
const { recordNotificationEvent } = require('./notifications');

const emitter = new EventEmitter();
// status: 'idle' | 'pulling' | 'done' | 'error'. `lines` accumulates every progress line so far —
// a caller that starts watching mid-pull replays these before tailing new ones live (see
// routes/admin.js), instead of joining silently partway through with no context.
const state = { status: 'idle', model: null, lines: [] };

function getState() {
  return state;
}

// Returns true if this call actually started a new pull, false if one for this exact model was
// already running (the caller should just subscribe()/tail the existing one instead of treating
// that as a no-op).
function startPull({ baseUrl, apiKey, model }) {
  if (state.status === 'pulling' && state.model === model) return false;

  state.status = 'pulling';
  state.model = model;
  state.lines = [];

  let lastStatus = '';
  let lastBucket = -1;
  function emitLine(line) {
    state.lines.push(line);
    emitter.emit('line', line);
  }

  pullModel({
    baseUrl,
    apiKey,
    model,
    onProgress: (part) => {
      // Same collapsing logic routes/admin.js's own streamed pull used before this refactor —
      // Ollama emits one of these per network chunk received, easily hundreds for a multi-GB
      // model, so this only emits a line on an actual status/digest change or a new 10% bucket.
      if (part.status !== lastStatus) {
        emitLine(part.status);
        lastStatus = part.status;
        lastBucket = -1;
      }
      if (part.total && Number.isFinite(part.completed)) {
        const bucket = Math.floor((part.completed / part.total) * 10);
        if (bucket !== lastBucket) {
          emitLine(`  ${bucket * 10}%`);
          lastBucket = bucket;
        }
      }
    },
  }).then(async () => {
    state.status = 'done';
    await recordNotificationEvent(
      { title: 'AI Assistant model ready', message: `"${model}" finished downloading and is ready to use.`, severity: 'info' },
      { eventType: 'ai_ollama_pull' }
    ).catch(() => {});
    emitter.emit('done');
  }).catch(async (err) => {
    state.status = 'error';
    emitLine(`Pull failed: ${err.message}`);
    await recordNotificationEvent(
      { title: 'AI Assistant model pull failed', message: `"${model}" failed to download: ${err.message}`, severity: 'warning' },
      { eventType: 'ai_ollama_pull' }
    ).catch(() => {});
    emitter.emit('done');
  });

  return true;
}

// onLine(line) fires for every progress line from THIS point forward — the caller replays
// getState().lines itself first for anything that already happened before subscribing (see
// routes/admin.js). onDone(status) fires exactly once, whether the pull running when subscribe()
// was called succeeds or fails. Returns an unsubscribe function, meant to be called when whatever
// this is feeding (an HTTP response) closes — it only ever stops THIS listener from hearing about
// further progress, it never touches the pull itself.
function subscribe(onLine, onDone) {
  function doneHandler() {
    emitter.off('line', onLine);
    onDone(state.status);
  }
  emitter.on('line', onLine);
  emitter.once('done', doneHandler);
  return () => {
    emitter.off('line', onLine);
    emitter.off('done', doneHandler);
  };
}

module.exports = { getState, startPull, subscribe };
