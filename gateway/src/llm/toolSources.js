// Combines LoxSuite's own instant local tools (../localDataTools.js) with the Miniserver's own MCP
// tools (../mcpClient.js) into one list every provider adapter hands to its model — same
// {name, description, inputSchema} shape either way, so each adapter's own per-provider conversion
// doesn't need to know or care which source a given tool came from. Local tools listed first, on
// the theory that whatever a model pays most attention to in a tool list, it's the ones it sees
// first — and these are the ones worth reaching for first (see localDataTools.js's own header
// comment for why: no network round trip on a cache hit, versus every MCP call being one).
async function listCombinedTools(miniserver, mcpClient, localDataTools) {
  if (!miniserver) return [];
  const [localTools, mcpTools] = await Promise.all([
    localDataTools.listLocalTools(),
    // An MCP connection issue (expired token, unreachable Miniserver) shouldn't take the local
    // tools down with it — worst case, the model just doesn't have control_state/control_find etc.
    // available for that turn.
    mcpClient.listTools(miniserver).catch(() => []),
  ]);
  return [...localTools, ...mcpTools];
}

// Single dispatch point for executing whichever tool the model asked for, regardless of provider.
async function callCombinedTool(miniserver, mcpClient, localDataTools, name, input) {
  if (localDataTools.isLocalTool(name)) return localDataTools.callLocalTool(miniserver, name, input);
  return mcpClient.callTool(miniserver, name, input);
}

module.exports = { listCombinedTools, callCombinedTool };
