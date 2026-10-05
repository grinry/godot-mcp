> This project is a fork of [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp), originally created by Solomon Elias.

# Godot MCP by grinry

[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white 'Node.js')](https://nodejs.org/en/download/)
[![](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white 'TypeScript')](https://www.typescriptlang.org/)

[![](https://img.shields.io/github/last-commit/grinry/godot-mcp 'Last Commit')](https://github.com/grinry/godot-mcp/commits/main)
[![](https://img.shields.io/github/stars/grinry/godot-mcp 'Stars')](https://github.com/grinry/godot-mcp/stargazers)
[![](https://img.shields.io/github/forks/grinry/godot-mcp 'Forks')](https://github.com/grinry/godot-mcp/network/members)
[![](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)


```text
                           (((((((             (((((((
                        (((((((((((           (((((((((((
                        (((((((((((((       (((((((((((((
                        (((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((
         (((((      (((((((((((((((((((((((((((((((((((((((((      (((((
       (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
     ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
    ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
      (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
        (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((@@@@@@@(((((((((((((((((((((((((((@@@@@@@(((((((((((
         (((((((((@@@@,,,,,@@@(((((((((((((((((((((@@@,,,,,@@@@(((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         (((((((((@@@,,,,,,,@@((((((((@@@@@((((((((@@,,,,,,,@@@(((((((((
         ((((((((((((@@@@@@(((((((((((@@@@@(((((((((((@@@@@@((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         @@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@
         ((((((((( @@@(((((((((((@@(((((((((((@@(((((((((((@@@ (((((((((
         (((((((((( @@((((((((((@@@(((((((((((@@@((((((((((@@ ((((((((((
          (((((((((((@@@@@@@@@@@@@@(((((((((((@@@@@@@@@@@@@@(((((((((((
           (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
              (((((((((((((((((((((((((((((((((((((((((((((((((((((
                 (((((((((((((((((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((


                          /$$      /$$  /$$$$$$  /$$$$$$$
                         | $$$    /$$$ /$$__  $$| $$__  $$
                         | $$$$  /$$$$| $$  \__/| $$  \ $$
                         | $$ $$/$$ $$| $$      | $$$$$$$/
                         | $$  $$$| $$| $$      | $$____/
                         | $$\  $ | $$| $$    $$| $$
                         | $$ \/  | $$|  $$$$$$/| $$
                         |__/     |__/ \______/ |__/
```

A Model Context Protocol (MCP) server for interacting with the Godot game engine.

The npm package for this fork is [`@grinry/godot-mcp`](https://www.npmjs.com/package/@grinry/godot-mcp).

## Introduction

Godot MCP enables AI agents to launch the Godot editor, run projects, capture debug output, and control project execution. This direct feedback loop helps agents understand what works and what doesn't in real Godot projects, leading to better code generation and debugging assistance.

## Features

- **Launch Godot Editor**: Open the Godot editor for a specific project
- **Run Godot Projects**: Execute Godot projects in debug mode
- **Capture Debug Output**: Retrieve console output and error messages
- **Control Execution**: Start and stop Godot projects programmatically
- **Get Godot Version**: Retrieve the installed Godot version
- **List Godot Projects**: Find Godot projects in a specified directory
- **Project Analysis**: Get detailed information about project structure
- **Scene Management**:
  - Create new scenes with specified root node types
  - Add nodes to existing scenes with customizable properties
  - Load sprites and textures into Sprite2D nodes
  - Export 3D scenes as MeshLibrary resources for GridMap
  - Save scenes with options for creating variants
- **UID Management** (for Godot 4.4+):
  - Get UID for specific files
  - Update UID references by resaving resources

## Requirements

- [Godot Engine](https://godotengine.org/download) installed on your system
- Node.js (>=18.0.0) and npm
- An AI agent that supports MCP

## Quick Start

### Codex

With the Codex CLI installed, register the server:

```bash
codex mcp add godot -- npx -y @grinry/godot-mcp
```

With environment variables, use this command instead:

```bash
codex mcp add godot --env GODOT_PATH=/path/to/godot --env DEBUG=true -- npx -y @grinry/godot-mcp
```

Alternatively, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.godot]
command = "npx"
args = ["-y", "@grinry/godot-mcp"]

[mcp_servers.godot.env]
GODOT_PATH = "/path/to/godot"
DEBUG = "true"
```

Omit `GODOT_PATH` to use automatic detection. Start a new Codex session after saving the configuration. Run `codex mcp list` to check registration, or `/mcp` in the Codex CLI to view active servers. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp) for more configuration options.

### Claude Code

```bash
claude mcp add godot -- npx @grinry/godot-mcp
```

That's it. Restart Claude Code and your Godot MCP tools are available.

With environment variables:

```bash
claude mcp add godot -e GODOT_PATH=/path/to/godot -e DEBUG=true -- npx @grinry/godot-mcp
```

<details>
<summary><strong>Cline</strong></summary>

Add to your Cline MCP settings file (`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@grinry/godot-mcp"],
      "env": {
        "DEBUG": "true"
      },
      "disabled": false,
      "autoApprove": [
        "launch_editor",
        "run_project",
        "get_debug_output",
        "stop_project",
        "get_godot_version",
        "list_projects",
        "get_project_info",
        "create_scene",
        "add_node",
        "load_sprite",
        "export_mesh_library",
        "save_scene",
        "get_uid",
        "update_project_uids"
      ]
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

**Using the Cursor UI:**

1. Go to **Cursor Settings** > **Features** > **MCP**
2. Click on the **+ Add New MCP Server** button
3. Fill out the form:
   - Name: `godot`
   - Type: `command`
   - Command: `npx @grinry/godot-mcp`
4. Click "Add"
5. You may need to press the refresh button in the top right corner of the MCP server card to populate the tool list

**Using Project-Specific Configuration:**

Create a file at `.cursor/mcp.json` in your project directory:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@grinry/godot-mcp"],
      "env": {
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Other MCP Clients</strong></summary>

For any MCP-compatible client, use this configuration:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@grinry/godot-mcp"],
      "env": {
        "GODOT_PATH": "/path/to/godot",
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GODOT_PATH` | Path to the Godot executable (overrides automatic detection) |
| `DEBUG` | Set to `"true"` to enable detailed server-side debug logging |

<details>
<summary><strong>Building from Source</strong></summary>

```bash
git clone https://github.com/grinry/godot-mcp.git
cd godot-mcp
npm install
npm run build
```

Then point your MCP client to `build/index.js` instead of using `npx`.

</details>


## Architecture

The Godot MCP server uses a bundled GDScript approach for complex operations:

1. **Direct Commands**: Simple operations like launching the editor or getting project info use Godot's built-in CLI commands directly.
2. **Bundled Operations Script**: Complex operations like creating scenes or adding nodes use a single, comprehensive GDScript file (`godot_operations.gd`) that handles all operations.

The bundled script accepts operation type and parameters as JSON, allowing for flexible and dynamic operation execution without generating temporary files for each operation.

## Troubleshooting

- **Godot Not Found**: Set the `GODOT_PATH` environment variable to your Godot executable path
- **Connection Issues**: Ensure the server is running and restart your AI assistant
- **Invalid Project Path**: Ensure the path points to a directory containing a `project.godot` file
- **Build Issues**: Make sure all dependencies are installed by running `npm install`

<details>
<summary><strong>Cursor-Specific Issues</strong></summary>

- Ensure the MCP server shows up and is enabled in Cursor settings (Settings > MCP)
- MCP tools can only be run using the Agent chat profile (Cursor Pro or Business subscription)
- Use "Yolo Mode" to automatically run MCP tool requests

</details>

## Releases

Releases use Changesets to manage versions and changelogs, then GitHub Actions to publish the public `@grinry/godot-mcp` npm package. See [Contributing](CONTRIBUTING.md#releases) for the contributor workflow and one-time maintainer setup.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
