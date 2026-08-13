// Drives one assistant turn against Ollama (or any Ollama-API-compatible server — OpenWebUI's own
// backend, LM Studio, etc.) via the official `ollama` npm package (the engine for talking to it —
// not a hand-rolled fetch() against its REST API). Unlike anthropic.js, there's no Tool Runner
// equivalent here to hand the request/execute-tool/repeat loop to — Ollama's own JS client is a
// thin wrapper over chat()/generate(), nothing agentic — so that loop is hand-written below, the
// same "manual loop" shape the claude-api skill itself documents for exactly this situation (no
// engine exists for it). MCP tools are converted to Ollama's own OpenAI-compatible tool schema by
// hand for the same reason mcpTools() exists on the Anthropic side, just without an SDK helper to
// do it — see mcpToolToOllamaTool() below.
const { Ollama } = require('ollama');
const { listCombinedTools, callCombinedTool } = require('./toolSources');

function buildClient(baseUrl, apiKey) {
  return new Ollama({
    host: baseUrl || 'http://127.0.0.1:11434',
    // Only ever set by someone pointing this at a REMOTE Ollama-compatible server behind a
    // reverse proxy/gateway that requires one (a bare local Ollama needs no auth at all) — see
    // admin-ai.ejs's own copy on this field being optional.
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
}

// Loxone's MCP server's own tool descriptions are written for a cloud model with a fast GPU and
// cheap tokens — multi-paragraph prose, verified against a real Miniserver at ~1.2KB average per
// tool across 9 tools (~7KB/~1800 tokens total). On CPU-only Ollama that's a direct, measured
// latency cost, not a rounding error: a benchmark against this exact schema showed a *cold* first
// message taking 109s of prompt-eval alone for ~3.3K prompt tokens (~33ms/token here) before the
// model does anything — a warm/cached repeat of the identical prompt dropped that to 80ms, so this
// tax is paid on every NEW conversation (or whenever something else evicts the cache), not just
// once. The per-parameter guidance that actually prevents bad tool calls (e.g. control_state's own
// `room`/`state_name`/`uuid` field descriptions) lives in inputSchema, which this leaves untouched
// — only the top-level prose overview gets capped, since a terser one-line summary is enough for a
// model that's about to see the full parameter docs anyway.
const MAX_TOOL_DESCRIPTION_CHARS = 220;

function truncateToolDescription(description) {
  if (!description || description.length <= MAX_TOOL_DESCRIPTION_CHARS) return description || '';
  const cut = description.slice(0, MAX_TOOL_DESCRIPTION_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + '…';
}

// Ollama's own MCP-shaped Tool type (name, description, inputSchema — see @modelcontextprotocol/
// sdk's Tool interface, the same raw shape mcpClient.listTools() returns) converted to the
// OpenAI-compatible {type, function: {name, description, parameters}} schema Ollama's own /api/chat
// documents for its `tools` parameter.
function mcpToolToOllamaTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: truncateToolDescription(tool.description),
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  };
}

async function buildToolsFor(miniserver, mcpClient, localDataTools) {
  const rawTools = await listCombinedTools(miniserver, mcpClient, localDataTools);
  return rawTools.map(mcpToolToOllamaTool);
}

// arguments comes back as an already-parsed object per Ollama's own documented /api/chat response
// shape — defensively parsed anyway in case a given model/proxy stringifies it instead (the way
// OpenAI's own API always does), same "don't trust a wire shape you can't fully control" reasoning
// as everywhere else external input crosses into this app.
function parseToolArguments(rawArgs) {
  if (typeof rawArgs !== 'string') return rawArgs || {};
  try {
    return JSON.parse(rawArgs);
  } catch {
    return {};
  }
}

// A verified-slow real turn traced back to a Miniserver MCP tool result (a control_state call
// spanning an entire room, 176 states) being fed back into the model's context whole — on CPU
// inference, reprocessing a context that large from scratch (Ollama's chat API is stateless across
// requests, and every tool-loop iteration resends the full history) dwarfed the actual per-token
// generation time. This is a hard backstop under the system prompt's own "narrow down first"
// instruction (see routes/aiChat.js) — it truncates regardless of whether the model followed that
// instruction, so one oversized tool call can't blow up every remaining reply in the conversation.
const MAX_TOOL_RESULT_CHARS = 4000;

function truncateToolResult(text) {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const cut = text.slice(0, MAX_TOOL_RESULT_CHARS);
  const remaining = text.length - MAX_TOOL_RESULT_CHARS;
  return `${cut}\n\n[...truncated, ${remaining} more characters omitted. Whatever you were looking for may be in the omitted part — do NOT guess or state a value from memory/estimation. Call control_find scoped to the specific room/control, then control_state with its uuid, to get just the value you need instead of one that returns everything.]`;
}

// onToken(delta) is called for every streamed text chunk, across however many tool-use iterations
// the turn takes — same contract as anthropic.js's runTurn, so routes/aiChat.js can call whichever
// provider's adapter identically. `effort` is accepted but unused — Ollama has no equivalent of
// Anthropic's extended-thinking effort levels.
async function runTurn({ apiKey, baseUrl, model, system, messages, miniserver, mcpClient, localDataTools, onToken, maxToolCalls }) {
  const client = buildClient(baseUrl, apiKey);
  const tools = await buildToolsFor(miniserver, mcpClient, localDataTools);

  const chatMessages = [{ role: 'system', content: system }, ...messages];
  const toolCalls = [];
  const limit = maxToolCalls || 20;

  for (let iteration = 0; iteration < limit; iteration++) {
    const stream = await client.chat({
      model,
      messages: chatMessages,
      tools: tools.length ? tools : undefined,
      stream: true,
      // Bounds worst-case generation time regardless of context size or how verbose a given model
      // gets — verified against a real turn that was still narrating a raw tool result's JSON
      // structure back at the user well past a thousand characters in, many minutes in. A genuine
      // answer to a home-automation chat question fits comfortably under this; it exists to cut off
      // a runaway ramble, not to constrain normal replies.
      options: { num_predict: 1024 },
    });

    let assistantText = '';
    let pendingToolCalls = [];
    for await (const part of stream) {
      if (part.message?.content) {
        assistantText += part.message.content;
        onToken && onToken(part.message.content);
      }
      if (part.message?.tool_calls?.length) pendingToolCalls = pendingToolCalls.concat(part.message.tool_calls);
    }

    if (!pendingToolCalls.length) {
      chatMessages.push({ role: 'assistant', content: assistantText });
      return { stopReason: 'end_turn', toolCalls };
    }

    chatMessages.push({ role: 'assistant', content: assistantText, tool_calls: pendingToolCalls });

    for (const call of pendingToolCalls) {
      const name = call.function.name;
      const input = parseToolArguments(call.function.arguments);
      toolCalls.push({ id: call.id || `${name}-${toolCalls.length}`, name, input });

      let resultText;
      try {
        const result = await callCombinedTool(miniserver, mcpClient, localDataTools, name, input);
        resultText = truncateToolResult(JSON.stringify(result));
      } catch (err) {
        resultText = `Error: ${err.message}`;
      }
      // Ollama's own chat API expects a tool result fed back as a plain {role: 'tool', content}
      // message (same shape OpenAI's Chat Completions API uses) — no separate tool_call_id linkage
      // Ollama's own docs call for, unlike OpenAI's stricter variant.
      chatMessages.push({ role: 'tool', content: resultText });
    }
  }

  throw new Error(`Reached the maximum number of tool calls (${limit}) for this turn.`);
}

// A bare model name ("llama3.2") means "llama3.2:latest" as far as Ollama itself is concerned —
// GET /api/tags always lists the fully-tagged form, so a naive exact-string match against
// whatever an admin typed (very plausibly untagged) would report an already-pulled model as
// missing forever. Normalizing both sides the same way before comparing is what actually matches
// Ollama's own resolution rule, not a guess at one.
function normalizeModelName(name) {
  return name.includes(':') ? name : `${name}:latest`;
}

// GET /api/tags via the client's own list() — every model already pulled into this Ollama/
// OpenWebUI instance, as plain tag strings. Used both to check availability and (implicitly, by
// its absence) to decide whether pullModel() below needs to do anything at all.
async function listModels(baseUrl, apiKey) {
  const client = buildClient(baseUrl, apiKey);
  const { models } = await client.list();
  return models.map((m) => m.model || m.name);
}

async function isModelAvailable(baseUrl, apiKey, model) {
  const installed = await listModels(baseUrl, apiKey);
  const target = normalizeModelName(model);
  return installed.some((name) => normalizeModelName(name) === target);
}

// Same GET /api/tags call as listModels() above, but keeping size/modified_at too — for
// admin-ai.ejs's own "pulled models" list (with a Delete button per row), where a bare name isn't
// enough to show what's actually taking up disk space.
async function listModelsDetailed(baseUrl, apiKey) {
  const client = buildClient(baseUrl, apiKey);
  const { models } = await client.list();
  return models.map((m) => ({
    name: m.model || m.name,
    size: m.size,
    modifiedAt: m.modified_at,
  }));
}

// DELETE /api/delete via the client's own delete() — removes one pulled model from disk. Used by
// admin-ai.ejs's own per-model Delete button, the UI counterpart to `docker exec ollama ollama rm
// <model>`. Deleting the model the settings row currently points at is allowed same as it would be
// from the CLI — the next page load's own status check simply reports it missing again and offers
// to re-pull it, no special guard needed here for that.
async function deleteModel(baseUrl, apiKey, model) {
  const client = buildClient(baseUrl, apiKey);
  await client.delete({ model });
}

// Streams POST /api/pull's own progress via the client's pull({stream: true}) — an AsyncGenerator
// of {status, digest?, total?, completed?} objects, ending with {status: 'success'} once the model
// is fully downloaded and verified. onProgress(part) is called for every one, letting the caller
// (routes/admin.js's own streamed response, mirroring routes/setup.js's import step) show live
// text instead of a bare spinner while a multi-gigabyte model downloads.
async function pullModel({ baseUrl, apiKey, model, onProgress }) {
  const client = buildClient(baseUrl, apiKey);
  const stream = await client.pull({ model, stream: true });
  for await (const part of stream) {
    onProgress && onProgress(part);
  }
}

module.exports = { runTurn, listModels, listModelsDetailed, isModelAvailable, pullModel, deleteModel };
