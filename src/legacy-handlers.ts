import type { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { observeEditorStartup } from './editor-startup.js';
import type { ProcessSlot } from './godot-process.js';
import type { LiveSession } from './live-session.js';
import { type OperationRunner, processReport, requireSuccess } from './operation-runner.js';
import { projectRoot, projectFile as resolveProjectFile } from './project-paths.js';

export interface LegacyHost {
  godotPath: string | null;
  game: ProcessSlot;
  editor: ProcessSlot;
  live: LiveSession;
  operations: OperationRunner;
  requestSignal: AsyncLocalStorage<AbortSignal>;
  detectGodotPath(): Promise<void>;
  normalizeParameters(params: Record<string, unknown>): Record<string, unknown>;
  logDebug(message: string): void;
  createErrorResponse(message: string, solutions?: string[]): CallToolResult;
  validatePath(path: string): boolean;
  validateClassName(name: string): boolean;
  isGodot44OrLater(version: string): boolean;
  findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }>;
  executeOperation(
    operation: string,
    params: Record<string, unknown>,
    projectPath: string,
  ): Promise<{ stdout: string; stderr: string }>;
}

function resolveResourcePath(projectPath: string, resourcePath: string) {
  return join(projectPath, resourcePath.replace(/^res:\/\//, ''));
}

/** Legacy handlers retain their existing argument normalization and result shapes. */
export class LegacyToolHandlers {
  constructor(private readonly host: LegacyHost) {}
  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  async handleLaunchEditor(args: any): Promise<CallToolResult> {
    // Normalize parameters to camelCase
    args = this.host.normalizeParameters(args);

    if (!args.projectPath) {
      return this.host.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.host.validatePath(args.projectPath)) {
      return this.host.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.host.godotPath) {
        await this.host.detectGodotPath();
        if (!this.host.godotPath) {
          return this.host.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.host.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      this.host.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
      const child = await this.host.editor.start(this.host.godotPath, [
        '-e',
        '--path',
        args.projectPath,
      ]);
      const startup = await observeEditorStartup(child, this.host.requestSignal.getStore());
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
      return this.host.createErrorResponse(`Failed to launch Godot editor: ${errorMessage}`, [
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
  async handleRunProject(args: any): Promise<CallToolResult> {
    // Normalize parameters to camelCase
    args = this.host.normalizeParameters(args);

    if (!args.projectPath) {
      return this.host.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.host.validatePath(args.projectPath)) {
      return this.host.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.host.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
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
      await this.host.live.close();
      const signal = this.host.requestSignal.getStore();
      signal?.throwIfAborted();
      const child = await this.host.game.start(this.host.godotPath!, cmdArgs, timeout);
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
      return this.host.createErrorResponse(`Failed to run Godot project: ${errorMessage}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  async handleGetDebugOutput(): Promise<CallToolResult> {
    if (!this.host.game.current)
      return this.host.createErrorResponse('No Godot run has been started');
    return {
      content: [{ type: 'text', text: JSON.stringify(processReport(this.host.game.current)) }],
    };
  }

  async handleStopProject(): Promise<CallToolResult> {
    try {
      await this.host.live.close();
      const child = await this.host.game.stop();
      if (!child) return this.host.createErrorResponse('No Godot run has been started');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              message: 'Godot project stopped',
              ...processReport(child),
              finalOutput: child.output,
              finalErrors: child.errors,
            }),
          },
        ],
      };
    } catch (error) {
      return this.host.createErrorResponse(String(error));
    }
  }

  /**
   * Handle the get_godot_version tool
   */
  async handleGetGodotVersion(): Promise<CallToolResult> {
    try {
      // Ensure godotPath is set
      if (!this.host.godotPath) {
        await this.host.detectGodotPath();
        if (!this.host.godotPath) {
          return this.host.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      this.host.logDebug('Getting Godot version');
      const { stdout } = requireSuccess(
        await this.host.operations.run(
          this.host.godotPath!,
          ['--version'],
          10000,
          this.host.requestSignal.getStore(),
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
      return this.host.createErrorResponse(`Failed to get Godot version: ${errorMessage}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]);
    }
  }

  /**
   * Handle the list_projects tool
   */
  async handleListProjects(args: any): Promise<CallToolResult> {
    // Normalize parameters to camelCase
    args = this.host.normalizeParameters(args);

    if (!args.directory) {
      return this.host.createErrorResponse('Directory is required', [
        'Provide a valid directory path to search for Godot projects',
      ]);
    }

    if (!this.host.validatePath(args.directory)) {
      return this.host.createErrorResponse('Invalid directory path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      this.host.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return this.host.createErrorResponse(`Directory does not exist: ${args.directory}`, [
          'Provide a valid directory path that exists on the system',
        ]);
      }

      const recursive = args.recursive === true;
      const projects = this.host.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.host.createErrorResponse(
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
        this.host.logDebug(`Error getting project structure asynchronously: ${error}`);
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
  async handleGetProjectInfo(args: any): Promise<CallToolResult> {
    // Normalize parameters to camelCase
    args = this.host.normalizeParameters(args);

    if (!args.projectPath) {
      return this.host.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.host.validatePath(args.projectPath)) {
      return this.host.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.host.godotPath) {
        await this.host.detectGodotPath();
        if (!this.host.godotPath) {
          return this.host.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.host.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      this.host.logDebug(`Getting project info for: ${args.projectPath}`);

      // Get Godot version
      const { stdout } = requireSuccess(
        await this.host.operations.run(
          this.host.godotPath!,
          ['--version'],
          10000,
          this.host.requestSignal.getStore(),
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
          this.host.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.host.logDebug(`Error reading project file: ${error}`);
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
      return this.host.createErrorResponse(
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
  async handleCreateScene(args: any): Promise<CallToolResult> {
    // Normalize parameters to camelCase
    args = this.host.normalizeParameters(args);

    if (!args.projectPath || !args.scenePath) {
      return this.host.createErrorResponse('Project path and scene path are required', [
        'Provide valid paths for both the project and the scene',
      ]);
    }

    if (!this.host.validatePath(args.projectPath) || !this.host.validatePath(args.scenePath)) {
      return this.host.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    const rootNodeType = args.rootNodeType || 'Node2D';
    if (!this.host.validateClassName(rootNodeType)) {
      return this.host.createErrorResponse('Invalid rootNodeType', [
        'rootNodeType must be a built-in Godot class name (no paths, no file extensions)',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.host.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
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
      const { stdout, stderr } = await this.host.executeOperation(
        'create_scene',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.host.createErrorResponse(`Failed to create scene: ${stderr}`, [
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
      return this.host.createErrorResponse(
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
  async handleAddNode(args: any): Promise<CallToolResult> {
    // Normalize parameters to camelCase
    args = this.host.normalizeParameters(args);

    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return this.host.createErrorResponse('Missing required parameters', [
        'Provide projectPath, scenePath, nodeType, and nodeName',
      ]);
    }

    if (!this.host.validatePath(args.projectPath) || !this.host.validatePath(args.scenePath)) {
      return this.host.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    if (!this.host.validateClassName(args.nodeType)) {
      return this.host.createErrorResponse('Invalid nodeType', [
        'nodeType must be a built-in Godot class name (no paths, no file extensions)',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.host.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.host.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
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
      const { stdout, stderr } = await this.host.executeOperation(
        'add_node',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.host.createErrorResponse(`Failed to add node: ${stderr}`, [
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
      return this.host.createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ],
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  async handleLoadSprite(args: any): Promise<CallToolResult> {
    // Normalize parameters to camelCase
    args = this.host.normalizeParameters(args);

    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return this.host.createErrorResponse('Missing required parameters', [
        'Provide projectPath, scenePath, nodePath, and texturePath',
      ]);
    }

    if (
      !this.host.validatePath(args.projectPath) ||
      !this.host.validatePath(args.scenePath) ||
      !this.host.validatePath(args.nodePath) ||
      !this.host.validatePath(args.texturePath)
    ) {
      return this.host.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.host.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.host.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
          'Ensure the scene path is correct',
          'Use create_scene to create a new scene first',
        ]);
      }

      // Check if the texture file exists
      const texturePath = resolveResourcePath(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return this.host.createErrorResponse(`Texture file does not exist: ${args.texturePath}`, [
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
      const { stdout, stderr } = await this.host.executeOperation(
        'load_sprite',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.host.createErrorResponse(`Failed to load sprite: ${stderr}`, [
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
      return this.host.createErrorResponse(
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
  async handleExportMeshLibrary(args: any): Promise<CallToolResult> {
    // Normalize parameters to camelCase
    args = this.host.normalizeParameters(args);

    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return this.host.createErrorResponse('Missing required parameters', [
        'Provide projectPath, scenePath, and outputPath',
      ]);
    }

    if (
      !this.host.validatePath(args.projectPath) ||
      !this.host.validatePath(args.scenePath) ||
      !this.host.validatePath(args.outputPath)
    ) {
      return this.host.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.host.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.host.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
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
      const { stdout, stderr } = await this.host.executeOperation(
        'export_mesh_library',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.host.createErrorResponse(`Failed to export mesh library: ${stderr}`, [
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
      return this.host.createErrorResponse(
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
  async handleSaveScene(args: any): Promise<CallToolResult> {
    // Normalize parameters to camelCase
    args = this.host.normalizeParameters(args);

    if (!args.projectPath || !args.scenePath) {
      return this.host.createErrorResponse('Missing required parameters', [
        'Provide projectPath and scenePath',
      ]);
    }

    if (!this.host.validatePath(args.projectPath) || !this.host.validatePath(args.scenePath)) {
      return this.host.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    // If newPath is provided, validate it
    if (args.newPath && !this.host.validatePath(args.newPath)) {
      return this.host.createErrorResponse('Invalid new path', [
        'Provide a valid new path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.host.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.host.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
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
      const { stdout, stderr } = await this.host.executeOperation(
        'save_scene',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.host.createErrorResponse(`Failed to save scene: ${stderr}`, [
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
      return this.host.createErrorResponse(
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
  async handleGetUid(args: any): Promise<CallToolResult> {
    // Normalize parameters to camelCase
    args = this.host.normalizeParameters(args);

    if (!args.projectPath || !args.filePath) {
      return this.host.createErrorResponse('Missing required parameters', [
        'Provide projectPath and filePath',
      ]);
    }

    if (!this.host.validatePath(args.projectPath) || !this.host.validatePath(args.filePath)) {
      return this.host.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.host.godotPath) {
        await this.host.detectGodotPath();
        if (!this.host.godotPath) {
          return this.host.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.host.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Check if the file exists
      const filePath = resolveResourcePath(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return this.host.createErrorResponse(`File does not exist: ${args.filePath}`, [
          'Ensure the file path is correct',
        ]);
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = requireSuccess(
        await this.host.operations.run(
          this.host.godotPath!,
          ['--version'],
          10000,
          this.host.requestSignal.getStore(),
        ),
      );
      const version = versionOutput.trim();

      if (!this.host.isGodot44OrLater(version)) {
        return this.host.createErrorResponse(
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
      const { stdout, stderr } = await this.host.executeOperation(
        'get_uid',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.host.createErrorResponse(`Failed to get UID: ${stderr}`, [
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
      return this.host.createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ],
      );
    }
  }

  /**
   * Handle the update_project_uids tool
   */
  async handleUpdateProjectUids(args: any): Promise<CallToolResult> {
    // Normalize parameters to camelCase
    args = this.host.normalizeParameters(args);

    if (!args.projectPath) {
      return this.host.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.host.validatePath(args.projectPath)) {
      return this.host.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.host.godotPath) {
        await this.host.detectGodotPath();
        if (!this.host.godotPath) {
          return this.host.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.host.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = requireSuccess(
        await this.host.operations.run(
          this.host.godotPath!,
          ['--version'],
          10000,
          this.host.requestSignal.getStore(),
        ),
      );
      const version = versionOutput.trim();

      if (!this.host.isGodot44OrLater(version)) {
        return this.host.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ],
        );
      }

      // Godot only persists script/shader .uid files during editor import.
      requireSuccess(
        await this.host.operations.run(
          this.host.godotPath!,
          ['--headless', '--editor', '--path', args.projectPath, '--import'],
          60000,
          this.host.requestSignal.getStore(),
        ),
      );

      // Godot resource scanning uses res://; --path already selects the project.
      const params = {
        projectPath: 'res://',
      };

      // Execute the operation
      const { stdout, stderr } = await this.host.executeOperation(
        'resave_resources',
        params,
        args.projectPath,
      );

      if (stderr?.includes('Failed to')) {
        return this.host.createErrorResponse(`Failed to update project UIDs: ${stderr}`, [
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
      return this.host.createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ],
      );
    }
  }
}
