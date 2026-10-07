// Fictional stdio MCP server for tests: one `echo` tool that also reports whether the credential arrived.
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const server = new McpServer({ name: 'fixture-echo', version: '1.0.0' })
server.registerTool(
  'echo',
  { description: 'Echo the text back.', inputSchema: z.object({ text: z.string() }) },
  async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}:${process.env.FIXTURE_TOKEN ? 'token' : 'no-token'}` }],
  }),
)
await server.connect(new StdioServerTransport())
