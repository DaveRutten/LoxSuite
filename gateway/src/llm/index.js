// Provider dispatch — the one thing routes/aiChat.js actually imports. Every adapter shares the
// exact same runTurn({...}) -> {stopReason, toolCalls} contract, so adding another provider is
// "write the adapter module, add one line here", not a routes.js change.
const anthropic = require('./anthropic');
const ollama = require('./ollama');
const openai = require('./openai');
const gemini = require('./gemini');

const PROVIDERS = { anthropic, ollama, openai, gemini };

async function runTurn(provider, opts) {
  const adapter = PROVIDERS[provider];
  if (!adapter) throw new Error(`Unknown AI provider "${provider}".`);
  return adapter.runTurn(opts);
}

module.exports = { runTurn };
