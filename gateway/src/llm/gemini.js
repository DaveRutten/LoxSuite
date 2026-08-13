// Drives one assistant turn against Google's Gemini API via the official `@google/genai` npm
// package — the engine for talking to it. Like ollama.js (and unlike anthropic.js/openai.js, both
// of which have a real Tool Runner that executes tool callbacks itself), this SDK's own Automatic
// Function Calling has real ambiguity around whether/how it actually executes a caller's function
// automatically when driven through the streaming Chat API this file uses — not something to guess
// at per this skill's own "never guess SDK usage" rule — so the request/execute-tool/feed-result-
// back/repeat loop is hand-written below instead, against the SDK's unambiguous, ground-truth-
// verified building blocks (Chat.sendMessageStream, response.functionCalls, a functionResponse
// Part fed back via the next sendMessage call).
const { GoogleGenAI } = require('@google/genai');
const { listCombinedTools, callCombinedTool } = require('./toolSources');

function buildClient(apiKey) {
  return new GoogleGenAI({ apiKey });
}

// MCP's own Tool shape (name, description, inputSchema — raw JSON Schema) maps onto
// FunctionDeclaration.parametersJsonSchema directly, with NO conversion needed at all — unlike
// Ollama/OpenAI's `parameters` field (which is Gemini's OWN, older, OpenAPI-flavored `Schema` type,
// not raw JSON Schema), parametersJsonSchema is documented to accept plain JSON Schema verbatim.
async function buildToolsFor(miniserver, mcpClient, localDataTools) {
  const rawTools = await listCombinedTools(miniserver, mcpClient, localDataTools);
  if (!rawTools.length) return [];
  return [{
    functionDeclarations: rawTools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      parametersJsonSchema: tool.inputSchema || { type: 'object', properties: {} },
    })),
  }];
}

// Gemini's own chat history shape ({role: 'user'|'model', parts: [{text}]}) rather than the
// {role, content} pairs every other adapter's own `messages` arg already uses — converted here so
// routes/aiChat.js doesn't need a provider-specific shape of its own. The most recent message is
// held back and sent via sendMessageStream() below (chats.create()'s own `history` is exactly
// that: history BEFORE this turn's message, not including it).
function toGeminiHistory(messages) {
  return messages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

// onToken(delta) is called for every streamed text chunk, across however many tool-use iterations
// the turn takes — same contract as every other adapter's own runTurn. `effort`/`baseUrl` are
// accepted for a uniform call site; neither has a Gemini equivalent (there's no self-hosted/custom-
// endpoint concept for the hosted Gemini API the way there is for Ollama).
async function runTurn({ apiKey, model, system, messages, miniserver, mcpClient, localDataTools, onToken, maxToolCalls }) {
  const client = buildClient(apiKey);
  const tools = await buildToolsFor(miniserver, mcpClient, localDataTools);
  const toolCalls = [];
  const limit = maxToolCalls || 20;

  const chat = client.chats.create({
    model,
    config: {
      systemInstruction: system,
      tools: tools.length ? tools : undefined,
    },
    history: toGeminiHistory(messages),
  });

  // PartListUnion accepts a plain string for an ordinary text turn, or an array of Parts for a
  // functionResponse round trip (built below) — both are valid `message` values for the same
  // sendMessageStream() call, so this one loop variable covers the whole turn regardless of which
  // kind the NEXT iteration needs to send.
  let nextMessage = messages[messages.length - 1]?.content || '';

  for (let iteration = 0; iteration < limit; iteration++) {
    const stream = await chat.sendMessageStream({ message: nextMessage });

    let pendingCalls = [];
    for await (const chunk of stream) {
      if (chunk.text) onToken && onToken(chunk.text);
      if (chunk.functionCalls?.length) pendingCalls = pendingCalls.concat(chunk.functionCalls);
    }

    if (!pendingCalls.length) return { stopReason: 'end_turn', toolCalls };

    const responseParts = [];
    for (const call of pendingCalls) {
      const input = call.args || {};
      toolCalls.push({ id: call.id || `${call.name}-${toolCalls.length}`, name: call.name, input });

      // "output"/"error" keys are FunctionResponse.response's own documented convention for
      // success vs. failure — not an arbitrary shape this file invented.
      let response;
      try {
        response = { output: await callCombinedTool(miniserver, mcpClient, localDataTools, call.name, input) };
      } catch (err) {
        response = { error: err.message };
      }
      responseParts.push({ functionResponse: { name: call.name, response } });
    }
    nextMessage = responseParts;
  }

  throw new Error(`Reached the maximum number of tool calls (${limit}) for this turn.`);
}

module.exports = { runTurn };
