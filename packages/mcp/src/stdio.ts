// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBuiryMcpServer } from './server.js';
import { RestBackend } from './rest-backend.js';

/** Entry for the MCP package binary (`npx <name from release.json>`): BUIRY_TOKEN and BUIRY_API_URL come from the MCP client config. */
export async function runStdio(env: Record<string, string | undefined> = process.env): Promise<void> {
  const token = env.BUIRY_TOKEN;
  const baseUrl = env.BUIRY_API_URL;
  if (!token || !baseUrl) {
    process.stderr.write('buiry-mcp: set BUIRY_TOKEN and BUIRY_API_URL (run `buiry connect <tool>`)\n');
    process.exit(2);
  }
  const server = createBuiryMcpServer({
    backend: new RestBackend({ baseUrl, token, sessionId: randomUUID() }),
  });
  await server.connect(new StdioServerTransport());
}
