import type { CallToolResult, Tool } from '@modelcontextprotocol/server';

export type ToolAccess = 'read' | 'control' | 'execute';
export type ToolSession = 'none' | 'start' | 'use';
export type ToolSpecification = Tool & { access: ToolAccess; session: ToolSession };
export interface RegisteredTool {
  tool: Tool;
  access: ToolAccess;
  session: ToolSession;
  handle(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
}
