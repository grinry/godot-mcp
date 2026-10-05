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
  type Tool,
} from '@modelcontextprotocol/server';
import { type StdioServerHandle, serveStdio } from '@modelcontextprotocol/server/stdio';
import { authoringTools, handleAuthoringTool } from './authoring-tools.js';
import { observeEditorStartup } from './editor-startup.js';
import { GodotSession } from './godot-session.js';
import { OperationRunner, requireSuccess } from './operation-runner.js';
import { projectOutput, projectRoot, projectFile as resolveProjectFile } from './project-paths.js';
import { versionedStdio } from './stdio-transport.js';
import { isReadTool, ToolPolicy } from './tool-policy.js';
import { extraTools, handleExtraTool, inputParameters } from './workflow-tools.js';

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
function resolveResourcePath(projectPath: string, resourcePath: string): string {
  return join(projectPath, resourcePath.replace(/^res:\/\//, ''));
}

function annotateTools(tools: Tool[]): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    inputSchema:
      sessionStarts.has(tool.name) || sessionUses.has(tool.name)
        ? {
            ...tool.inputSchema,
            properties: {
              ...tool.inputSchema.properties,
              sessionId: {
                type: 'string',
                description:
                  'Explicit process/debug session handle; required for follow-up tools on MCP 2026-07-28',
              },
            },
          }
        : tool.inputSchema,
    annotations: {
      readOnlyHint: isReadTool(tool.name),
      destructiveHint: !isReadTool(tool.name),
      openWorldHint: !isReadTool(tool.name),
    },
  }));
}

type Session = GodotSession;
const sessionStarts = new Set(['run_project', 'run_scene', 'launch_editor', 'start_debug_session']);
const sessionUses = new Set([
  'get_debug_output',
  'stop_project',
  'view_log',
  'quit_godot',
  'capture_screenshot',
  'simulate_input',
  'set_debug_pause',
  'get_runtime_tree',
  'close_session',
]);

class GodotServer {
  private server: Server;
  private transport?: StdioServerHandle;
  private readonly policy = new ToolPolicy();
  private readonly operations = new OperationRunner();
  private readonly requestSignal = new AsyncLocalStorage<AbortSignal>();
  private readonly defaultSession = new GodotSession();
  private readonly sessions = new Map<string, Session>();
  private readonly sessionContext = new AsyncLocalStorage<Session>();
  private get game() {
    return (this.sessionContext.getStore() ?? this.defaultSession).game;
  }
  private get editor() {
    return (this.sessionContext.getStore() ?? this.defaultSession).editor;
  }
  private get live() {
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
  private godotPath: string | null = null;
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
    max_depth: 'maxDepth',
    max_nodes: 'maxNodes',
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
          'Use trusted Godot projects. Import textures before loading sprites. Scene edits execute project scripts; invalid/unavailable script dependencies are rejected before saving. Configure a main scene or pass scenePath, then start_debug_session for runtime tree, input and screenshots. Display rendering is required for images. Editor launch checks early diagnostics; view_log retains later errors. validate_project checks GDScript only. Stop tracked sessions with stop_project or quit_godot.',
      },
    );

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
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  private createErrorResponse(message: string, possibleSolutions: string[] = []): any {
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
  private validatePath(path: string): boolean {
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
  private validateClassName(name: string): boolean {
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
  private async detectGodotPath() {
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
  private isGodot44OrLater(version: string): boolean {
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
  private normalizeParameters(params: OperationParams): OperationParams {
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

        // Handle nested objects recursively
        if (
          typeof params[key] === 'object' &&
          params[key] !== null &&
          !Array.isArray(params[key])
        ) {
          result[normalizedKey] = this.normalizeParameters(params[key] as OperationParams);
        } else {
          result[normalizedKey] = params[key];
        }
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

        // Handle nested objects recursively
        if (
          typeof params[key] === 'object' &&
          params[key] !== null &&
          !Array.isArray(params[key])
        ) {
          result[snakeKey] = this.convertCamelToSnakeCase(params[key] as OperationParams);
        } else {
          result[snakeKey] = params[key];
        }
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
  private async executeOperation(
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
  private findGodotProjects(
    directory: string,
    recursive: boolean,
  ): Array<{ path: string; name: string }> {
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
        tools: annotateTools([
          ...authoringTools,
          ...extraTools,
          {
            name: 'launch_editor',
            description: 'Launch Godot editor for a specific project',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: {
                  type: 'string',
                  description: 'Path to the Godot project directory',
                },
              },
              required: ['projectPath'],
            },
          },
          {
            name: 'run_project',
            description: 'Run the Godot project and capture output',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: {
                  type: 'string',
                  description: 'Path to the Godot project directory',
                },
                timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
                headless: { type: 'boolean' },
                scene: {
                  type: 'string',
                  description: 'Optional: Specific scene to run',
                },
              },
              required: ['projectPath'],
            },
          },
          {
            name: 'get_debug_output',
            description: 'Get the current debug output and errors',
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
            },
          },
          {
            name: 'stop_project',
            description: 'Stop the currently running Godot project',
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
            },
          },
          {
            name: 'get_godot_version',
            description: 'Get the installed Godot version',
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
            },
          },
          {
            name: 'list_projects',
            description: 'List Godot projects in a directory',
            inputSchema: {
              type: 'object',
              properties: {
                directory: {
                  type: 'string',
                  description: 'Directory to search for Godot projects',
                },
                recursive: {
                  type: 'boolean',
                  description: 'Whether to search recursively (default: false)',
                },
              },
              required: ['directory'],
            },
          },
          {
            name: 'get_project_info',
            description: 'Retrieve metadata about a Godot project',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: {
                  type: 'string',
                  description: 'Path to the Godot project directory',
                },
              },
              required: ['projectPath'],
            },
          },
          {
            name: 'create_scene',
            description: 'Create a new Godot scene file',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: {
                  type: 'string',
                  description: 'Path to the Godot project directory',
                },
                scenePath: {
                  type: 'string',
                  description: 'Path where the scene file will be saved (relative to project)',
                },
                rootNodeType: {
                  type: 'string',
                  description: 'Type of the root node (e.g., Node2D, Node3D)',
                },
              },
              required: ['projectPath', 'scenePath'],
            },
          },
          {
            name: 'add_node',
            description: 'Add a node to an existing scene',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: {
                  type: 'string',
                  description: 'Path to the Godot project directory',
                },
                scenePath: {
                  type: 'string',
                  description: 'Path to the scene file (relative to project)',
                },
                parentNodePath: {
                  type: 'string',
                  description: 'Path to the parent node (e.g., "root" or "root/Player")',
                },
                nodeType: {
                  type: 'string',
                  description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)',
                },
                nodeName: {
                  type: 'string',
                  description: 'Name for the new node',
                },
                properties: {
                  type: 'object',
                  description: 'Optional properties to set on the node',
                },
              },
              required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
            },
          },
          {
            name: 'load_sprite',
            description: 'Load a sprite into a Sprite2D node',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: {
                  type: 'string',
                  description: 'Path to the Godot project directory',
                },
                scenePath: {
                  type: 'string',
                  description: 'Path to the scene file (relative to project)',
                },
                nodePath: {
                  type: 'string',
                  description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
                },
                texturePath: {
                  type: 'string',
                  description: 'Path to the texture file (relative to project)',
                },
              },
              required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
            },
          },
          {
            name: 'export_mesh_library',
            description: 'Export a scene as a MeshLibrary resource',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: {
                  type: 'string',
                  description: 'Path to the Godot project directory',
                },
                scenePath: {
                  type: 'string',
                  description: 'Path to the scene file (.tscn) to export',
                },
                outputPath: {
                  type: 'string',
                  description: 'Path where the mesh library (.res) will be saved',
                },
                meshItemNames: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description:
                    'Optional: Names of specific mesh items to include (defaults to all)',
                },
              },
              required: ['projectPath', 'scenePath', 'outputPath'],
            },
          },
          {
            name: 'save_scene',
            description: 'Save changes to a scene file',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: {
                  type: 'string',
                  description: 'Path to the Godot project directory',
                },
                scenePath: {
                  type: 'string',
                  description: 'Path to the scene file (relative to project)',
                },
                newPath: {
                  type: 'string',
                  description: 'Optional: New path to save the scene to (for creating variants)',
                },
              },
              required: ['projectPath', 'scenePath'],
            },
          },
          {
            name: 'get_uid',
            description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: {
                  type: 'string',
                  description: 'Path to the Godot project directory',
                },
                filePath: {
                  type: 'string',
                  description: 'Path to the file (relative to project) for which to get the UID',
                },
              },
              required: ['projectPath', 'filePath'],
            },
          },
          {
            name: 'update_project_uids',
            description:
              'Update UID references in a Godot project by resaving resources (for Godot 4.4+)',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: {
                  type: 'string',
                  description: 'Path to the Godot project directory',
                },
              },
              required: ['projectPath'],
            },
          },
        ]),
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
        } else if (modern && sessionStarts.has(request.params.name)) {
          if (this.sessions.size >= 16)
            throw new Error('Session limit reached; close_session releases a session');
          id = randomUUID();
          session = new GodotSession();
          this.sessions.set(id, session);
          created = true;
        } else if (modern && sessionUses.has(request.params.name)) {
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
        (!sessionStarts.has(request.params.name) && !sessionUses.has(request.params.name))
          ? operation()
          : session.run(operation));
        if (created && result.isError) {
          await session.close();
          this.sessions.delete(id);
        } else if (typeof id === 'string' && sessionStarts.has(request.params.name)) {
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
      await this.policy.check(params.name, argumentsNormalized);
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
    if (authoringTools.some((tool) => tool.name === params.name)) {
      try {
        return await handleAuthoringTool(
          params.name,
          argumentsNormalized,
          this.godotPath!,
          join(__dirname, 'scripts'),
          this.operations,
          signal,
        );
      } catch (error) {
        return this.createErrorResponse(String(error));
      }
    }
    if (extraTools.some((tool) => tool.name === params.name)) {
      try {
        const args = this.normalizeParameters(params.arguments ?? {});
        if (params.name === 'run_scene' && typeof args.scenePath !== 'string')
          throw new Error('scenePath is required');
        if (params.name === 'run_scene')
          return await this.handleRunProject({
            ...args,
            scene: args.scenePath,
            timeoutMs: args.timeoutMs ?? 30000,
          });
        if (params.name === 'start_debug_session') {
          const root = await projectRoot(args.projectPath);
          const scene =
            args.scenePath === undefined
              ? ''
              : (await resolveProjectFile(root, args.scenePath, ['.tscn', '.scn'])).resource;
          if (args.headless !== undefined && typeof args.headless !== 'boolean')
            throw new Error('headless must be boolean');
          const result = await this.live.start(
            this.godotPath!,
            root,
            join(__dirname, 'scripts', 'live_session.gd'),
            scene,
            args.headless === true,
            signal,
          );
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        if (params.name === 'capture_screenshot') {
          const result = await this.live.request('screenshot', {}, signal);
          const { image, ...metadata } = result;
          if (typeof image !== 'string') throw new Error('Bridge did not return an image');
          return {
            content: [
              { type: 'image', mimeType: 'image/png', data: image },
              { type: 'text', text: JSON.stringify(metadata) },
            ],
          };
        }
        if (params.name === 'get_runtime_tree') {
          const maxDepth = args.maxDepth ?? 10;
          const maxNodes = args.maxNodes ?? 100;
          if (
            !Number.isInteger(maxDepth) ||
            maxDepth < 0 ||
            maxDepth > 20 ||
            !Number.isInteger(maxNodes) ||
            maxNodes < 1 ||
            maxNodes > 200
          )
            throw new Error('Invalid runtime tree limits');
          const result = await this.live.request('tree', { maxDepth, maxNodes }, signal);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        if (params.name === 'simulate_input') {
          const result = await this.live.request('input', inputParameters(args), signal);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        if (params.name === 'set_debug_pause') {
          if (typeof args.paused !== 'boolean') throw new Error('paused must be boolean');
          const result = await this.live.request('pause', { paused: args.paused }, signal);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        if (params.name === 'close_session') {
          await this.sessionContext.getStore()!.close();
          return { content: [{ type: 'text', text: 'Session closed' }] };
        }
        if (params.name === 'quit_godot') {
          await this.editor.stop();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(this.editor.current?.snapshot() ?? { running: false }),
              },
            ],
          };
        }
        if (params.name === 'view_log') {
          const count = args.lineCount ?? 200;
          if (!Number.isInteger(count) || count < 1 || count > 10000)
            throw new Error('lineCount must be between 1 and 10000');
          const snapshot = this.editor.current?.snapshot();
          if (!snapshot) throw new Error('No editor has been launched');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...snapshot,
                  output: snapshot.output.slice(-count),
                  errors: snapshot.errors.slice(-count),
                }),
              },
            ],
          };
        }
        return await handleExtraTool(
          params.name,
          args,
          this.godotPath!,
          join(__dirname, 'scripts'),
          signal,
          this.operations,
        );
      } catch (error) {
        return this.createErrorResponse(String(error));
      }
    }
    switch (params.name) {
      case 'launch_editor':
        return await this.handleLaunchEditor(params.arguments);
      case 'run_project':
        return await this.handleRunProject(params.arguments);
      case 'get_debug_output':
        return await this.handleGetDebugOutput();
      case 'stop_project':
        return await this.handleStopProject();
      case 'get_godot_version':
        return await this.handleGetGodotVersion();
      case 'list_projects':
        return await this.handleListProjects(params.arguments);
      case 'get_project_info':
        return await this.handleGetProjectInfo(params.arguments);
      case 'create_scene':
        return await this.handleCreateScene(params.arguments);
      case 'add_node':
        return await this.handleAddNode(params.arguments);
      case 'load_sprite':
        return await this.handleLoadSprite(params.arguments);
      case 'export_mesh_library':
        return await this.handleExportMeshLibrary(params.arguments);
      case 'save_scene':
        return await this.handleSaveScene(params.arguments);
      case 'get_uid':
        return await this.handleGetUid(params.arguments);
      case 'update_project_uids':
        return await this.handleUpdateProjectUids(params.arguments);
      default:
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${params.name}`);
    }
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
      const child = await this.editor.start(this.godotPath, ['-e', '--path', args.projectPath]);
      const startup = await observeEditorStartup(child, this.requestSignal.getStore());
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              projectPath: args.projectPath,
              ...startup,
              note: 'Process started; project readiness is not guaranteed. Use view_log for later diagnostics.',
            }),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(`Failed to launch Godot editor: ${errorMessage}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      const root = await projectRoot(args.projectPath);
      const cmdArgs = ['-d', '--path', root];
      if (args.scene !== undefined) {
        const scene = await resolveProjectFile(root, args.scene, ['.tscn', '.scn']);
        cmdArgs.push(scene.resource);
      }
      if (args.headless !== undefined && typeof args.headless !== 'boolean')
        throw new Error('headless must be boolean');
      if (args.headless === true) cmdArgs.unshift('--headless');
      const timeout = args.timeoutMs;
      if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 600000))
        throw new Error('timeoutMs must be between 1 and 600000');
      await this.live.close();
      const signal = this.requestSignal.getStore();
      signal?.throwIfAborted();
      const child = await this.game.start(this.godotPath!, cmdArgs, timeout);
      if (signal?.aborted) {
        await child.stop();
        signal.throwIfAborted();
      }

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(`Failed to run Godot project: ${errorMessage}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    if (!this.game.current) return this.createErrorResponse('No Godot run has been started');
    return { content: [{ type: 'text', text: JSON.stringify(this.game.current.snapshot()) }] };
  }

  private async handleStopProject() {
    try {
      await this.live.close();
      const child = await this.game.stop();
      if (!child) return this.createErrorResponse('No Godot run has been started');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              message: 'Godot project stopped',
              ...child.snapshot(),
              finalOutput: child.output,
              finalErrors: child.errors,
            }),
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(String(error));
    }
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = requireSuccess(
        await this.operations.run(
          this.godotPath!,
          ['--version'],
          10000,
          this.requestSignal.getStore(),
        ),
      );
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(`Failed to get Godot version: ${errorMessage}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]);
    }
  }

  /**
   * Handle the list_projects tool
   */
  private async handleListProjects(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!args.directory) {
      return this.createErrorResponse('Directory is required', [
        'Provide a valid directory path to search for Godot projects',
      ]);
    }

    if (!this.validatePath(args.directory)) {
      return this.createErrorResponse('Invalid directory path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return this.createErrorResponse(`Directory does not exist: ${args.directory}`, [
          'Provide a valid directory path that exists on the system',
        ]);
      }

      const recursive = args.recursive === true;
      const projects = this.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the directory exists and is accessible',
          'Check if you have permission to read the directory',
        ],
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });

          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);

            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }

            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();

              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (
                ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(
                  ext || '',
                )
              ) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };

        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      this.logDebug(`Getting project info for: ${args.projectPath}`);

      // Get Godot version
      const { stdout } = requireSuccess(
        await this.operations.run(
          this.godotPath!,
          ['--version'],
          10000,
          this.requestSignal.getStore(),
        ),
      );

      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(args.projectPath);

      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const projectFileContent = readFileSync(projectFile, 'utf8');
        const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
        if (configNameMatch?.[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                structure: projectStructure,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ],
      );
    }
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse('Project path and scene path are required', [
        'Provide valid paths for both the project and the scene',
      ]);
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    const rootNodeType = args.rootNodeType || 'Node2D';
    if (!this.validateClassName(rootNodeType)) {
      return this.createErrorResponse('Invalid rootNodeType', [
        'rootNodeType must be a built-in Godot class name (no paths, no file extensions)',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation(
        'create_scene',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.createErrorResponse(`Failed to create scene: ${stderr}`, [
          'Check if the root node type is valid',
          'Ensure you have write permissions to the scene path',
          'Verify the scene path is valid',
        ]);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ],
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, scenePath, nodeType, and nodeName',
      ]);
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    if (!this.validateClassName(args.nodeType)) {
      return this.createErrorResponse('Invalid nodeType', [
        'nodeType must be a built-in Godot class name (no paths, no file extensions)',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
          'Ensure the scene path is correct',
          'Use create_scene to create a new scene first',
        ]);
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      if (stderr?.includes('Failed to')) {
        return this.createErrorResponse(`Failed to add node: ${stderr}`, [
          'Check if the node type is valid',
          'Ensure the parent node path exists',
          'Verify the scene file is valid',
        ]);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to add node: ${error?.message || 'Unknown error'}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, scenePath, nodePath, and texturePath',
      ]);
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.texturePath)
    ) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
          'Ensure the scene path is correct',
          'Use create_scene to create a new scene first',
        ]);
      }

      // Check if the texture file exists
      const texturePath = resolveResourcePath(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return this.createErrorResponse(`Texture file does not exist: ${args.texturePath}`, [
          'Ensure the texture path is correct',
          'Upload or create the texture file first',
        ]);
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation(
        'load_sprite',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.createErrorResponse(`Failed to load sprite: ${stderr}`, [
          'Check if the node path is correct',
          'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
          'Verify the texture file is a valid image format',
        ]);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ],
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */
  private async handleExportMeshLibrary(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, scenePath, and outputPath',
      ]);
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.outputPath)
    ) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
          'Ensure the scene path is correct',
          'Use create_scene to create a new scene first',
        ]);
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation(
        'export_mesh_library',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.createErrorResponse(`Failed to export mesh library: ${stderr}`, [
          'Check if the scene contains valid 3D meshes',
          'Ensure the output path is valid',
          'Verify the scene file is valid',
        ]);
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ],
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath and scenePath',
      ]);
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    // If newPath is provided, validate it
    if (args.newPath && !this.validatePath(args.newPath)) {
      return this.createErrorResponse('Invalid new path', [
        'Provide a valid new path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
          'Ensure the scene path is correct',
          'Use create_scene to create a new scene first',
        ]);
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation(
        'save_scene',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.createErrorResponse(`Failed to save scene: ${stderr}`, [
          'Check if the scene file is valid',
          'Ensure you have write permissions to the output path',
          'Verify the scene can be properly packed',
        ]);
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ],
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.filePath) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath and filePath',
      ]);
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.filePath)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Check if the file exists
      const filePath = resolveResourcePath(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return this.createErrorResponse(`File does not exist: ${args.filePath}`, [
          'Ensure the file path is correct',
        ]);
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = requireSuccess(
        await this.operations.run(
          this.godotPath!,
          ['--version'],
          10000,
          this.requestSignal.getStore(),
        ),
      );
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ],
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      if (stderr?.includes('Failed to')) {
        return this.createErrorResponse(`Failed to get UID: ${stderr}`, [
          'Check if the file is a valid Godot resource',
          'Ensure the file path is correct',
        ]);
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to get UID: ${error?.message || 'Unknown error'}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = requireSuccess(
        await this.operations.run(
          this.godotPath!,
          ['--version'],
          10000,
          this.requestSignal.getStore(),
        ),
      );
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ],
        );
      }

      // Godot only persists script/shader .uid files during editor import.
      requireSuccess(
        await this.operations.run(
          this.godotPath!,
          ['--headless', '--editor', '--path', args.projectPath, '--import'],
          60000,
          this.requestSignal.getStore(),
        ),
      );

      // Godot resource scanning uses res://; --path already selects the project.
      const params = {
        projectPath: 'res://',
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation(
        'resave_resources',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.createErrorResponse(`Failed to update project UIDs: ${stderr}`, [
          'Check if the project is valid',
          'Ensure you have write permissions to the project directory',
        ]);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              ...JSON.parse(
                stdout
                  .split('\n')
                  .find((line) => line.startsWith('GODOT_MCP_UID_RESULT '))
                  ?.slice('GODOT_MCP_UID_RESULT '.length) ?? '{}',
              ),
              output: stdout,
            }),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ],
      );
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
