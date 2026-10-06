import type { Tool } from '@modelcontextprotocol/server';
import { authoringTools, handleAuthoringTool } from './authoring-tools.js';
import { configurationTools, handleConfigurationTool } from './configuration-tools.js';
import type { GodotSession } from './godot-session.js';
import type { LegacyToolHandlers } from './legacy-handlers.js';
import { legacyTools } from './legacy-tools.js';
import type { OperationRunner } from './operation-runner.js';
import { playtestTools, runPlaytest } from './playtest-tools.js';
import { overviewTool, projectOverview } from './project-overview.js';
import { handleResourceTool, resourceTools } from './resource-tools.js';
import { handleRuntimeTool, runtimeTools } from './runtime-tools.js';
import { handleSamplingTool, samplingTools } from './sampling-tools.js';
import { handleSceneTool, sceneTools } from './scene-tools.js';
import type { RegisteredTool } from './tool-types.js';
import { extraTools, handleExtraTool } from './workflow-tools.js';
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  constructor(entries: RegisteredTool[]) {
    for (const entry of entries) {
      if (this.tools.has(entry.tool.name)) throw new Error(`Duplicate tool: ${entry.tool.name}`);
      this.tools.set(entry.tool.name, entry);
    }
  }
  get(name: string) {
    return this.tools.get(name);
  }
  list(): Tool[] {
    return [...this.tools.values()].map(({ tool, access, session }) => ({
      ...tool,
      inputSchema:
        session === 'none'
          ? tool.inputSchema
          : {
              ...tool.inputSchema,
              properties: {
                ...tool.inputSchema.properties,
                sessionId: {
                  type: 'string',
                  description:
                    'Explicit process/debug session handle; required for follow-up tools on MCP 2026-07-28',
                },
              },
            },
      annotations: {
        readOnlyHint: access === 'read',
        destructiveHint: tool.annotations?.destructiveHint ?? false,
        openWorldHint: access === 'execute',
        ...tool.annotations,
      },
    }));
  }
}
interface Context {
  legacy: LegacyToolHandlers;
  godot(): string;
  scripts: string;
  runner: OperationRunner;
  session(): GodotSession;
}
export function createToolRegistry(context: Context) {
  const entries: RegisteredTool[] = legacyTools.map(({ handler, access, session, ...tool }) => ({
    tool,
    access,
    session,
    handle: async (args) => context.legacy[handler](args),
  }));
  for (const { access, session, ...tool } of authoringTools)
    entries.push({
      tool,
      access,
      session,
      handle: (args, signal) =>
        handleAuthoringTool(
          tool.name,
          args,
          context.godot(),
          context.scripts,
          context.runner,
          signal,
        ),
    });
  for (const { access, session, ...tool } of configurationTools)
    entries.push({
      tool,
      access,
      session,
      handle: (args, signal) =>
        handleConfigurationTool(
          tool.name,
          args,
          context.godot(),
          context.scripts,
          context.runner,
          signal,
        ),
    });
  for (const { access, session, ...tool } of sceneTools)
    entries.push({
      tool,
      access,
      session,
      handle: (args, signal) =>
        handleSceneTool(tool.name, args, context.godot(), context.scripts, context.runner, signal),
    });
  for (const { access, session, ...tool } of resourceTools)
    entries.push({
      tool,
      access,
      session,
      handle: (args, signal) =>
        handleResourceTool(
          tool.name,
          args,
          context.godot(),
          context.scripts,
          context.runner,
          signal,
        ),
    });
  for (const { access, session, ...tool } of playtestTools)
    entries.push({
      tool,
      access,
      session,
      handle: (args, signal) =>
        runPlaytest(args, context.session(), context.godot(), context.scripts, signal),
    });
  for (const { access, session, ...tool } of runtimeTools)
    entries.push({
      tool,
      access,
      session,
      handle: (args, signal) =>
        handleRuntimeTool(
          tool.name,
          args,
          context.session(),
          context.godot(),
          context.scripts,
          signal,
        ),
    });
  for (const { access, session, ...tool } of samplingTools)
    entries.push({
      tool,
      access,
      session,
      handle: (args, signal) => handleSamplingTool(tool.name, args, context.session(), signal),
    });
  for (const { access, session, ...tool } of extraTools)
    entries.push({
      tool,
      access,
      session,
      handle: (args, signal) =>
        tool.name === 'run_scene'
          ? runScene(context.legacy, args)
          : handleExtraTool(
              tool.name,
              args,
              context.godot(),
              context.scripts,
              signal,
              context.runner,
            ),
    });
  const { access, session, ...overview } = overviewTool;
  entries.push({
    tool: overview,
    access,
    session,
    handle: async (args, signal) => {
      const data = await projectOverview(args, signal);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    },
  });
  return new ToolRegistry(entries);
}

async function runScene(legacy: LegacyToolHandlers, args: Record<string, unknown>) {
  if (typeof args.scenePath !== 'string') throw new Error('scenePath is required');
  return legacy.handleRunProject({
    ...args,
    scene: args.scenePath,
    timeoutMs: args.timeoutMs ?? 30000,
  });
}
