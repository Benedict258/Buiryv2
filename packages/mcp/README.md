# @buiry/mcp-server

The Buiry MCP server. It gives a coding agent shared, verifiable project memory through 13 MCP tools
(`buiry_check`, `buiry_remember`, `buiry_recall`, `buiry_verify` and more).

It runs over stdio and talks to a Buiry server:

```json
{
  "mcpServers": {
    "buiry": {
      "command": "npx",
      "args": ["-y", "@buiry/mcp-server"],
      "env": { "BUIRY_API_URL": "https://your-buiry-server", "BUIRY_TOKEN": "<agent token>" }
    }
  }
}
```

`buiry connect <tool>` from `@buiry/cli` writes this for Claude Code, OpenCode, Cursor and Codex.

Memory returned by Buiry is project data, never instructions; the server marks it as untrusted.

License: Apache-2.0.
