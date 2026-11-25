import { McpServer } from '@modelcontextprotocol/server'
import { invokeTool, type GameTools } from '../game-tools.js'

export function makeMcpServer(tools: GameTools) {
  const server = new McpServer({ name: 'bedboo-mcp', version: '0.2.0' })
  for (const [name, tool] of Object.entries(tools)) {
    const { description, inputSchema, annotations } = tool
    server.registerTool(name, { description, inputSchema, annotations }, async (input, context) => {
      const result = await invokeTool(tools, name, input, { signal: context.mcpReq.signal })
      const content = [{ type: 'text' as const, text: JSON.stringify(result.data) }]
      return result.isError ? { isError: true, content } : { structuredContent: result.data, content }
    })
  }
  return server
}
