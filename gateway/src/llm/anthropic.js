// Drives one assistant turn via @anthropic-ai/sdk's own beta Tool Runner
// (client.beta.messages.toolRunner) — the request/execute-tool/feed-result-back/repeat loop,
// streaming, and message accumulation are the SDK's job, not hand-rolled here. MCP tools are
// converted to Tool-Runner-ready tools via the SDK's own mcpTools() helper (also an engine, not
// self-build) rather than a hand-written adapter — see buildToolsFor() below for the one thing it
// still needs from us: routing actual tool execution through mcpClient.js's own write-permission
// gate and command-audit logging instead of the raw MCP SDK Client mcpTools() would otherwise call
// directly.
const Anthropic = require('@anthropic-ai/sdk');
const { mcpTools } = require('@anthropic-ai/sdk/helpers/beta/mcp');

// Built lazily per call, not a module singleton — the API key can change via Administration > AI
// Assistant without needing a server restart to pick it up.
function buildClient(apiKey) {
  return new Anthropic({ apiKey });
}

async function buildToolsFor(miniserver, mcpClient) {
  if (!miniserver) return [];
  const rawTools = await mcpClient.listTools(miniserver);
  if (!rawTools.length) return [];
  // Satisfies mcpTools()'s own MCPClientLike interface ({callTool({name, arguments})}) while every
  // actual call still goes through mcpClient.callTool() — which is what enforces
  // ai_allow_write_commands and writes the Logs > Loxone commands audit trail. Passing the raw MCP
  // SDK Client instance directly here would bypass both.
  const guardedClient = {
    callTool: ({ name, arguments: args }) => mcpClient.callTool(miniserver, name, args),
  };
  return mcpTools(rawTools, guardedClient);
}

// onToken(delta) is called for every streamed text chunk, across however many tool-use iterations
// the turn takes — the caller doesn't need to know or care how many round trips happened.
async function runTurn({ apiKey, model, effort, system, messages, miniserver, mcpClient, onToken, maxToolCalls }) {
  const client = buildClient(apiKey);
  const tools = await buildToolsFor(miniserver, mcpClient);

  const runner = client.beta.messages.toolRunner({
    model,
    max_tokens: 8192,
    system,
    tools,
    messages,
    output_config: { effort },
    max_iterations: maxToolCalls,
    stream: true,
  });

  const toolCalls = [];
  for await (const messageStream of runner) {
    messageStream.on('text', (delta) => onToken && onToken(delta));
    messageStream.on('contentBlock', (block) => {
      if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
    });
    await messageStream.finalMessage();
  }

  const final = await runner.done();
  if (final.stop_reason === 'refusal') {
    throw new Error('The assistant declined to respond to that.');
  }
  return { stopReason: final.stop_reason, toolCalls };
}

module.exports = { runTurn };
