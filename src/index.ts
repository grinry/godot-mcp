#!/usr/bin/env node

/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CallToolResult,
  type ListToolsResult,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from '@modelcontextprotocol/server';
import { type StdioServerHandle, serveStdio } from '@modelcontextprotocol/server/stdio';
import { GodotSession } from './godot-session.js';
import { LegacyToolHandlers } from './legacy-handlers.js';
import { OperationRunner, requireSuccess } from './operation-runner.js';
import { projectOutput, projectRoot, projectFile as resolveProjectFile } from './project-paths.js';
import { versionedStdio } from './stdio-transport.js';
import { ToolPolicy } from './tool-policy.js';
import { createToolRegistry, type ToolRegistry } from './tool-registry.js';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE: boolean = true; // Always use GODOT DEBUG MODE

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
).version;

/**
 * Interface for server configuration
 */
interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean; // New option to control path validation behavior
}

/**
 * Interface for operation parameters
 */
interface OperationParams {
  [key: string]: any;
}

/**
 * Main server class for the Godot MCP server
 */
type Session = GodotSession;
class GodotServer {
  private server: Server;
  private transport?: StdioServerHandle;
  private readonly policy = new ToolPolicy();
  private registry: ToolRegistry;
  readonly operations = new OperationRunner();
  readonly requestSignal = new AsyncLocalStorage<AbortSignal>();
  private readonly defaultSession = new GodotSession();
  private readonly sessions = new Map<string, Session>();
  private readonly sessionContext = new AsyncLocalStorage<Session>();
  get game() {
    return (this.sessionContext.getStore() ?? this.defaultSession).game;
  }
  get editor() {
    return (this.sessionContext.getStore() ?? this.defaultSession).editor;
  }
  get live() {
    return (this.sessionContext.getStore() ?? this.defaultSession).live;
  }
  private closing = false;
  private async closeChildren() {
    this.closing = true;
    await Promise.all([
      this.operations.close(),
      ...[this.defaultSession, ...this.sessions.values()].map((session) => session.close()),
    ]);
  }
  godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;

  /**
   * Parameter name mappings between snake_case and camelCase
   * This allows the server to accept both formats
   */
  private parameterMappings: Record<string, string> = {
    project_path: 'projectPath',
    scene_path: 'scenePath',
    root_node_type: 'rootNodeType',
    parent_node_path: 'parentNodePath',
    node_type: 'nodeType',
    node_name: 'nodeName',
    texture_path: 'texturePath',
    node_path: 'nodePath',
    output_path: 'outputPath',
    mesh_item_names: 'meshItemNames',
    new_path: 'newPath',
    file_path: 'filePath',
    directory: 'directory',
    recursive: 'recursive',
    scene: 'scene',
    timeout_ms: 'timeoutMs',
    line_count: 'lineCount',
    test_file: 'testFile',
    include_subdirs: 'includeSubdirs',
    include_inherited: 'includeInherited',
    session_id: 'sessionId',
    script_path: 'scriptPath',
    target_node_path: 'targetNodePath',
    class_name: 'className',
    resource_path: 'resourcePath',
    instance_scene_path: 'instanceScenePath',
    physical_keycode: 'physicalKeycode',
    axis_value: 'axisValue',
    interval_frames: 'intervalFrames',
    command_or_control: 'commandOrControl',
    max_depth: 'maxDepth',
    max_nodes: 'maxNodes',
    max_properties: 'maxProperties',
    dry_run: 'dryRun',
    expected_hash: 'expectedHash',
    new_name: 'newName',
  };

  /**
   * Reverse mapping from camelCase to snake_case
   * Generated from parameterMappings for quick lookups
   */
  private reverseParameterMappings: Record<string, string> = {};

  constructor(config?: GodotServerConfig) {
    // Initialize reverse parameter mappings
    for (const [snakeCase, camelCase] of Object.entries(this.parameterMappings)) {
      this.reverseParameterMappings[camelCase] = snakeCase;
    }
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let _godotDebugMode = GODOT_DEBUG_MODE;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        _godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'godot-mcp',
        version: PACKAGE_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
        instructions:
          'Use trusted Godot projects. Start with get_project_overview and get_scene_info before editing. Preview modify_scene with dryRun, then pass its sourceHash as expectedHash to apply. instance_scene and duplicate_node also support scene transactions. Inspect resource classes with get_class_info and files with get_resource_info before create_resource or set_resource_properties; preview writes with dryRun. Import textures before loading sprites. Scene/resource operations execute project scripts; invalid/unavailable script dependencies are rejected before saving. Configure a main scene or pass scenePath, then start_debug_session for runtime tree, properties, input, screenshots and get_performance_monitors. Preview configuration writes with dryRun and apply with expectedHash; input actions replace their complete event list. Configuration serialization uses an isolated engine. Pause before step_frames, sample_performance or sample_node_properties; these advance frames and leave the session paused. Use run_playtest for bounded input/frame/state-assertion scenarios with automatic game cleanup; queued inputs require a following frames step. Display rendering is required for images. Editor launch checks early diagnostics; view_log retains later errors. validate_project checks GDScript only; use scripts or pattern to check changed files. Stop tracked sessions with stop_project or quit_godot and release explicit handles with close_session.',
      },
    );

    this.registry = createToolRegistry({
      legacy: new LegacyToolHandlers(this),
      godot: () => {
        if (!this.godotPath) throw new Error('Godot executable unavailable');
        return this.godotPath;
      },
      scripts: join(__dirname, 'scripts'),
      runner: this.operations,
      session: () => this.sessionContext.getStore() ?? this.defaultSession,
    });
    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    this.server.onclose = () => {
      void this.closeChildren().catch((error) => console.error('Godot cleanup failed:', error));
    };

    // Cleanup on exit
    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  createErrorResponse(message: string, possibleSolutions: string[] = []): any {
    // Log the error
    console.error(`[SERVER] Error response: ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: any = {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
    };

    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: `Possible solutions:\n- ${possibleSolutions.join('\n- ')}`,
      });
    }

    return response;
  }

  /**
   * Validate a path to prevent path traversal attacks
   */
  validatePath(path: string): boolean {
    // Basic validation to prevent path traversal
    if (!path || path.includes('..')) {
      return false;
    }

    // Add more validation as needed
    return true;
  }

  /**
   * Validate a Godot class name to prevent arbitrary script instantiation.
   * Class names must be simple identifiers (e.g. "Node2D", "CharacterBody3D").
   * Rejects anything that looks like a path (res://, absolute paths, dots, slashes, colons).
   */
  validateClassName(name: string): boolean {
    if (!name) return false;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }

  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      // Try to execute Godot with --version flag
      requireSuccess(
        await this.operations.run(path, ['--version'], 10000, this.requestSignal.getStore()),
      );

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && (await this.isValidGodotPath(this.godotPath))) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`,
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`,
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`,
      );
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.error(
      `[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`,
    );

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(
        `Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`,
      );
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.error(
        `[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`,
      );
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    await this.closeChildren();
    await this.transport?.close();
    await this.server.close();
  }

  /**
   * Check if the Godot version is 4.4 or later
   * @param version The Godot version string
   * @returns True if the version is 4.4 or later
   */
  isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 4 || (major === 4 && minor >= 4);
    }
    return false;
  }

  /**
   * Normalize parameters to camelCase format
   * @param params Object with either snake_case or camelCase keys
   * @returns Object with all keys in camelCase format
   */
  normalizeParameters(params: OperationParams): OperationParams {
    if (!params || typeof params !== 'object') {
      return params;
    }

    const result: OperationParams = {};

    for (const key in params) {
      if (Object.hasOwn(params, key)) {
        let normalizedKey = key;

        // If the key is in snake_case, convert it to camelCase using our mapping
        if (key.includes('_') && this.parameterMappings[key]) {
          normalizedKey = this.parameterMappings[key];
        }

        // Property dictionaries contain Godot names, not MCP argument names.
        if (
          normalizedKey === 'properties' ||
          normalizedKey === 'expected' ||
          normalizedKey === 'value'
        )
          result[normalizedKey] = params[key];
        else if (
          (normalizedKey === 'operations' ||
            normalizedKey === 'steps' ||
            normalizedKey === 'events') &&
          Array.isArray(params[key])
        )
          result[normalizedKey] = params[key].map((operation) =>
            this.normalizeParameters(operation),
          );
        else if (
          typeof params[key] === 'object' &&
          params[key] !== null &&
          !Array.isArray(params[key])
        )
          result[normalizedKey] = this.normalizeParameters(params[key] as OperationParams);
        else result[normalizedKey] = params[key];
      }
    }

    return result;
  }

  /**
   * Convert camelCase keys to snake_case
   * @param params Object with camelCase keys
   * @returns Object with snake_case keys
   */
  private convertCamelToSnakeCase(params: OperationParams): OperationParams {
    const result: OperationParams = {};

    for (const key in params) {
      if (Object.hasOwn(params, key)) {
        // Convert camelCase to snake_case
        const snakeKey =
          this.reverseParameterMappings[key] ||
          key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

        if (key === 'properties') result[snakeKey] = params[key];
        else if (
          typeof params[key] === 'object' &&
          params[key] !== null &&
          !Array.isArray(params[key])
        )
          result[snakeKey] = this.convertCamelToSnakeCase(params[key] as OperationParams);
        else result[snakeKey] = params[key];
      }
    }

    return result;
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string,
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);

    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    try {
      // Serialize the snake_case parameters to a valid JSON string
      const paramsJson = JSON.stringify(snakeCaseParams);

      // Pass native argument arrays to the owned runner without shell interpretation
      const args = [
        '--headless',
        '--path',
        projectPath, // Safe: passed as argument, not interpolated into shell command
        '--script',
        this.operationsScriptPath,
        operation,
        paramsJson, // Safe: passed as argument, not interpreted by shell
      ];

      if (GODOT_DEBUG_MODE) {
        args.push('--debug-godot');
      }

      this.logDebug(`Executing: ${this.godotPath} ${args.join(' ')}`);

      const child = await this.operations.run(
        this.godotPath!,
        args,
        60000,
        this.requestSignal.getStore(),
      );
      return requireSuccess(child);
    } catch (error: unknown) {
      if (error instanceof Error && 'stderr' in error) {
        const stderr = String(error.stderr ?? '');
        throw new Error(`Godot operation failed: ${error.message}\n${stderr}`);
      }

      throw error;
    }
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    // Define available tools
    this.server.setRequestHandler(
      'tools/list',
      async (): Promise<ListToolsResult> => ({
        tools: this.registry.list(),
      }),
    );

    // Handle tool calls
    this.server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult> => {
      const args = this.normalizeParameters(request.params.arguments ?? {});
      const modern = ctx.mcpReq.envelope !== undefined;
      let id = args.sessionId;
      let session = this.defaultSession;
      let created = false;
      try {
        if (this.closing) throw new Error('Server is shutting down');
        if (id !== undefined) {
          if (typeof id !== 'string' || !this.sessions.has(id))
            throw new Error('Unknown sessionId');
          session = this.sessions.get(id)!;
        } else if (modern && this.registry.get(request.params.name)?.session === 'start') {
          if (this.sessions.size >= 16)
            throw new Error('Session limit reached; close_session releases a session');
          id = randomUUID();
          session = new GodotSession();
          this.sessions.set(id, session);
          created = true;
        } else if (modern && this.registry.get(request.params.name)?.session === 'use') {
          throw new Error('sessionId is required for this tool on MCP 2026-07-28');
        }
        const operation = () =>
          this.requestSignal.run(ctx.mcpReq.signal, () =>
            this.sessionContext.run(session, () => {
              ctx.mcpReq.signal.throwIfAborted();
              return this.handleTool({ ...request.params, arguments: args }, ctx.mcpReq.signal);
            }),
          );
        const result = await (request.params.name === 'close_session' ||
        (this.registry.get(request.params.name)?.session !== 'start' &&
          this.registry.get(request.params.name)?.session !== 'use')
          ? operation()
          : session.run(operation));
        if (created && result.isError) {
          await session.close();
          this.sessions.delete(id);
        } else if (
          typeof id === 'string' &&
          this.registry.get(request.params.name)?.session === 'start'
        ) {
          result.content.push({ type: 'text', text: JSON.stringify({ sessionId: id }) });
        }
        if (request.params.name === 'close_session' && !result.isError && typeof id === 'string')
          this.sessions.delete(id);
        return result;
      } catch (error) {
        if (created) {
          try {
            await session.close();
            this.sessions.delete(id);
          } catch (cleanupError) {
            console.error('Session cleanup failed:', cleanupError);
          }
        }
        return this.createErrorResponse(String(error));
      }
    });
  }

  private async handleTool(
    params: { name: string; arguments?: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    this.logDebug(`Handling tool request: ${params.name}`);
    const argumentsNormalized = this.normalizeParameters(params.arguments ?? {});
    try {
      await this.policy.check(
        params.name,
        argumentsNormalized,
        this.registry.get(params.name)?.access,
      );
      if (params.name === 'close_session' && typeof argumentsNormalized.sessionId !== 'string')
        throw new Error('sessionId is required');
      if (
        process.platform === 'linux' &&
        process.env.WSL_DISTRO_NAME &&
        this.godotPath?.toLowerCase().endsWith('.exe') &&
        ![
          'get_debug_output',
          'view_log',
          'stop_project',
          'quit_godot',
          'close_session',
          'list_projects',
          'list_project_files',
        ].includes(params.name)
      )
        throw new Error(
          'Use a Linux Godot executable inside WSL, or run both this server and Godot natively on Windows. Windows Godot cannot consume WSL project/resource paths directly.',
        );
      if (argumentsNormalized.projectPath !== undefined) {
        const root = await projectRoot(argumentsNormalized.projectPath);
        argumentsNormalized.projectPath = root;
        if (params.name === 'create_scene')
          argumentsNormalized.scenePath = (
            await projectOutput(root, argumentsNormalized.scenePath, ['.tscn', '.scn'])
          ).resource;
        if (['add_node', 'load_sprite', 'export_mesh_library', 'save_scene'].includes(params.name))
          argumentsNormalized.scenePath = (
            await resolveProjectFile(root, argumentsNormalized.scenePath, ['.tscn', '.scn'])
          ).resource;
        if (params.name === 'load_sprite')
          argumentsNormalized.texturePath = (
            await resolveProjectFile(root, argumentsNormalized.texturePath)
          ).resource;
        if (params.name === 'save_scene' && argumentsNormalized.newPath !== undefined)
          argumentsNormalized.newPath = (
            await projectOutput(root, argumentsNormalized.newPath, ['.tscn', '.scn'])
          ).resource;
        if (params.name === 'export_mesh_library')
          argumentsNormalized.outputPath = (
            await projectOutput(root, argumentsNormalized.outputPath, ['.res', '.tres'])
          ).resource;
        if (params.name === 'get_uid')
          argumentsNormalized.filePath = (
            await resolveProjectFile(root, argumentsNormalized.filePath)
          ).resource;
      }
    } catch (error) {
      return this.createErrorResponse(String(error));
    }
    params.arguments = argumentsNormalized;
    const tool = this.registry.get(params.name);
    if (!tool)
      throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${params.name}`);
    try {
      return await tool.handle(argumentsNormalized, signal);
    } catch (error) {
      return this.createErrorResponse(String(error));
    }
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Detect Godot path before starting the server
      await this.detectGodotPath();

      if (!this.godotPath) {
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error(
          '[SERVER] Please set GODOT_PATH environment variable or provide a valid path',
        );
        process.exit(1);
      }

      // Check if the path is valid
      const isValid = await this.isValidGodotPath(this.godotPath);

      if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error(
            '[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path',
          );
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.error(
            `[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`,
          );
          console.error('[SERVER] This may cause issues when executing Godot commands');
          console.error(
            '[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.',
          );
        }
      }

      console.error(`[SERVER] Using Godot at: ${this.godotPath}`);

      this.transport = serveStdio(() => this.server, { transport: versionedStdio() });
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server
const server = new GodotServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', errorMessage);
  process.exit(1);
});
