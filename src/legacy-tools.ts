import type { Tool } from '@modelcontextprotocol/server';
import type { LegacyToolHandlers } from './legacy-handlers.js';
import type { ToolAccess, ToolSession } from './tool-types.js';

export const legacyTools: (Tool & {
  handler: keyof LegacyToolHandlers;
  access: ToolAccess;
  session: ToolSession;
})[] = [
  {
    name: 'launch_editor',
    handler: 'handleLaunchEditor',
    access: 'execute',
    session: 'start',
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
    handler: 'handleRunProject',
    access: 'execute',
    session: 'start',
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
    handler: 'handleGetDebugOutput',
    access: 'read',
    session: 'use',
    description: 'Get the current debug output and errors',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'stop_project',
    handler: 'handleStopProject',
    access: 'control',
    session: 'use',
    description: 'Stop the currently running Godot project',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_godot_version',
    handler: 'handleGetGodotVersion',
    access: 'read',
    session: 'none',
    description: 'Get the installed Godot version',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_projects',
    handler: 'handleListProjects',
    access: 'read',
    session: 'none',
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
    handler: 'handleGetProjectInfo',
    access: 'read',
    session: 'none',
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
    handler: 'handleCreateScene',
    access: 'execute',
    session: 'none',
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
    handler: 'handleAddNode',
    access: 'execute',
    session: 'none',
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
    handler: 'handleLoadSprite',
    access: 'execute',
    session: 'none',
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
    handler: 'handleExportMeshLibrary',
    access: 'execute',
    session: 'none',
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
          description: 'Optional: Names of specific mesh items to include (defaults to all)',
        },
      },
      required: ['projectPath', 'scenePath', 'outputPath'],
    },
  },
  {
    name: 'save_scene',
    handler: 'handleSaveScene',
    access: 'execute',
    session: 'none',
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
    handler: 'handleGetUid',
    access: 'read',
    session: 'none',
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
    handler: 'handleUpdateProjectUids',
    access: 'execute',
    session: 'none',
    description: 'Update UID references in a Godot project by resaving resources (for Godot 4.4+)',
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
];
