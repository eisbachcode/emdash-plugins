# @eisbachcode/emdash-plugin-analytics

## 0.2.0

### Minor Changes

- 4ff7bd9: Adds four read-only MCP tools, so an AI agent connected to EmDash's MCP server can ask for the numbers: `analytics__top_entries`, `analytics__unviewed_entries`, `analytics__entry_views` and `analytics__site_totals`. They read what the plugin has stored, never call Cloudflare, and every answer says which UTC days it covers, where stored history starts and when the last sync ran.
  
  The tools stay off until an administrator turns on **Agent access** for the plugin under Plugins. A caller needs `plugins:read` (editor and above) and a token with the `mcp:tools:analytics` or `mcp:tools` scope.
  
  On EmDash 0.39 and 0.40 only sandboxed and registry installs get the tools. A plugin registered in `plugins: []` lists none; that is an EmDash limitation, and nothing else about the plugin changes there.
