// Drives one assistant turn against OpenAI (or an OpenAI-compatible endpoint via baseUrl) via the
// official `openai` npm package's own Tool Runner (client.chat.completions.runTools) — the
// request/execute-tool/feed-result-back/repeat loop and streaming are the SDK's job here, same as
// anthropic.js's own Tool Runner, not hand-rolled the way ollama.js's manual loop has to be (OpenAI
// ships a real engine for this; Ollama's client doesn't). MCP tools are converted to runTools' own
// RunnableToolFunction shape by hand — there's no mcpTools()-style helper for a non-Anthropic MCP
// client the way there is on the Anthropic side, so buildToolsFor() below is this file's version
// of that adapter step.
const OpenAI = require('openai');
const { listCombinedTools, callCombinedTool } = require('./toolSources');

function buildClient(apiKey, baseUrl) {
  return new OpenAI({ apiKey, baseURL: baseUrl || undefined });
}

// Each MCP tool becomes a RunnableToolFunction: `function.function` is the ACTUAL callable the
// runner invokes when the model requests this tool, not just a declarative schema — the runner
// sends its return value back to the model itself, so there's no separate "append a tool result
// message" step the way ollama.js's/gemini.js's own manual loops need.
async function buildToolsFor(miniserver, mcpClient, localDataTools) {
  const rawTools = await listCombinedTools(miniserver, mcpClient, localDataTools);
  return rawTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} },
      parse: JSON.parse,
      function: async (args) => {
        const result = await callCombinedTool(miniserver, mcpClient, localDataTools, tool.name, args);
        return JSON.stringify(result);
      },
    },
  }));
}

// onToken(delta) is called for every streamed text chunk, across however many tool-use iterations
// the turn takes — same contract as anthropic.js/ollama.js's own runTurn. `effort`/`baseUrl` are
// accepted for a uniform call site in routes/aiChat.js; effort has no OpenAI equivalent, and
// baseUrl is rarely set (only for an OpenAI-COMPATIBLE proxy — stock OpenAI needs neither).
async function runTurn({ apiKey, baseUrl, model, system, messages, miniserver, mcpClient, localDataTools, onToken, maxToolCalls }) {
  const client = buildClient(apiKey, baseUrl);
  const tools = await buildToolsFor(miniserver, mcpClient, localDataTools);
  const toolCalls = [];

  const runner = client.chat.completions.runTools({
    stream: true,
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    tools: tools.length ? tools : undefined,
    maxChatCompletions: maxToolCalls || 20,
  });

  runner.on('content', (delta) => onToken && onToken(delta));
  runner.on('functionToolCall', (call) => {
    let input = {};
    try { input = JSON.parse(call.arguments); } catch { /* leave empty — matches every other adapter's own defensive parse */ }
    toolCalls.push({ id: call.name, name: call.name, input });
  });

  // Waits for the ENTIRE run (every tool round trip, not just the first completion) —
  // same reasoning as anthropic.js's own `await runner.done()`.
  await runner.finalMessage();
  return { stopReason: 'end_turn', toolCalls };
}

module.exports = { runTurn };
