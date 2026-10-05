> This project is a fork of [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp), originally created by Solomon Elias.

# Godot MCP

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
- Node.js (>=22.14.0) and npm
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

### Autohand Code

```bash
autohand mcp add godot npx @grinry/godot-mcp
```

For a project-scoped registration, use `autohand mcp add --scope project godot npx @grinry/godot-mcp`. On macOS/Linux, a custom executable can be passed with `autohand mcp add godot env GODOT_PATH=/path/to/godot npx @grinry/godot-mcp`. See [Autohand Code](https://github.com/autohandai/code-cli) for platform-specific environment configuration.

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

## Validation and feedback tools

Requires Node.js **22.14 or newer** and Godot 4. The MCP SDK has been upgraded and the unused Axios dependency removed.

| Tool | Behavior |
|---|---|
| `list_project_files` | Lists scenes, scripts and resources. Accepts `type`, a relative glob `pattern`, and `limit` (default 1,000, maximum 10,000). Skips hidden files and symlinks; reports `truncated` when a traversal/result limit is reached. |
| `run_scene` | Runs `scenePath` (relative or `res://`) and stops after `timeoutMs` (default 30,000, maximum 600,000). Optional `headless`. |
| `validate_project` | Checks discovered GDScript files with Godot `--check-only`, retaining every diagnostic. Default total timeout: 60 seconds. C# and gameplay are outside this check. |
| `run_scene_test` | Runs a headless scene and returns `passed`, exit code, timeout status, output and diagnostics. A test scene must call `get_tree().quit(0)` for success or a nonzero code for failure. Default timeout: 60 seconds. |
| `export_project` | Uses an existing `preset` from `export_presets.cfg`, writing `outputPath`. Requires matching Godot export templates. Optional `debug` and `timeoutMs`. |
| `capture_scene_screenshot` | Runs a fresh `scenePath`, waits `frames` (default 3), and returns an inline PNG. Requires a display renderer; output uses a private temporary directory that is removed afterward. Default timeout: 30 seconds. |
| `view_log` | Reads the latest launched editor's output and errors; `lineCount` defaults to 200. |
| `quit_godot` | Terminates the editor launched by this server and waits for exit. Save editor changes first: unsaved changes may be lost. |

`run_project` also accepts `headless` and `timeoutMs`. Game and editor launches each replace the preceding process of the same kind. `get_debug_output` retains the most recent game's final logs after exit or timeout. Logs are bounded to 1 MiB per process and 10,000 lines per stream; truncation is reported. Scene paths reject traversal and symlinks that escape the project.

`add_node` converts JSON numeric arrays to Vector2/3/4, their integer variants, Quaternion and Color properties. Colors accept three or four components; other vectors require the exact component count. Invalid properties fail before saving the scene. Integral JSON numbers are accepted for integer properties.

### Imported textures

Before `load_sprite`, open the project in Godot or run `godot --headless --editor --path /path/to/project --import`. Godot must generate import metadata for the texture; copying a PNG alone is insufficient. Use its project resource path (for example, `res://textures/player.png`).

### Verification

Run `npm test` for process lifecycle and discovery regression tests. Set `GODOT_TEST_PATH` to a Godot 4 executable to include the real-engine MCP and scene-editing integration test:

```bash
GODOT_TEST_PATH=/path/to/godot npm test
```

## Live visual feedback and input

Call `start_debug_session` with `projectPath` and optional `scenePath` to run a game with the temporary debug bridge. If no scene is supplied, the configured main scene is used. `capture_screenshot` returns a PNG of that running game's current state; `capture_scene_screenshot` starts a separate fresh scene.

The bridge uses a private temporary directory with authenticated requests, bounded messages and unique response IDs. It installs no addon, changes no autoload settings, and opens no network port. It runs only in the game process explicitly launched by `start_debug_session`; exported games do not include it. Godot may still generate its normal `.godot` import cache.

Use `simulate_input` with one of the argument objects below (one event per call):

```json
[
  { "kind": "action", "action": "ui_accept", "pressed": true },
  { "kind": "key", "keycode": 32, "pressed": true },
  { "kind": "mouse_button", "button": 1, "x": 120, "y": 80, "pressed": true },
  { "kind": "mouse_motion", "x": 120, "y": 80 }
]
```

Send `pressed: false` to release a held input. Actions must exist in the project's InputMap. Events use [Godot's input event dispatch](https://docs.godotengine.org/en/4.4/classes/class_input.html#class-input-method-parse-input-event), so scene input callbacks can observe them. `set_debug_pause` accepts `paused: true` or `false`; screenshots preserve that state. A headless session supports input and logs but cannot render screenshots. `stop_project`, another game launch, or server shutdown stops the session and removes temporary bridge files. Request cancellation/timeouts also stop the affected live session.

## GUT tests

Install [GUT](https://github.com/bitwes/Gut) in `addons/gut`, then import the project once in Godot. `run_gut_tests` accepts `projectPath` and exactly one `testFile` or `directory` (relative or `res://`). Optional arguments: `headless` (default true), `includeSubdirs` (default true), `logLevel` (0–3), and `timeoutMs` (default 60,000; maximum 600,000). It reports exit status, diagnostics, truncation and timeout, and rejects a run with no tests. It follows the [GUT command-line runner](https://gut.readthedocs.io/en/9.3.1/Command-Line.html); integration has been verified with GUT 9.6.1.

## Desktop bundle and Codex plugin

`npm run build:mcpb` creates `dist/godot-mcp-VERSION.mcpb`. It rebuilds the source, bundles runtime dependencies, copies all Godot scripts, validates the manifest, and verifies that the bundled server exposes the same MCP tools. Import the bundle into a desktop client supporting MCPB and configure its Godot executable path. Node.js >=22.14 and Godot must be available on the client machine. CI verifies the bundle; successful npm releases attach it to the matching GitHub release. Desktop installation itself has not been automated.

The repository also includes `.codex-plugin/plugin.json` and `.codex-plugin/mcp.json` for local/repository plugin distribution using the [supported Codex compatibility layout](https://developers.openai.com/plugins/build/plugins). Its launcher uses the published `@grinry/godot-mcp` package. Changesets updates the plugin version when preparing a release. The Codex CLI configuration above remains available for direct MCP registration.

To exercise the display and GUT integrations locally:

```bash
GODOT_TEST_PATH=/path/to/godot GODOT_TEST_RENDER=true GODOT_TEST_EXPORT=true GUT_TEST_ADDON_PATH=/path/to/addons/gut npm test
```

`update_project_uids` performs a headless editor import before resaving resources, so Godot creates script/shader `.uid` files in editor mode. It verifies missing UID files rather than reporting a save as successful generation.

## Scene authoring and reflection

| Tool | Behavior |
|---|---|
| `attach_script` | Attaches `scriptPath` (`.gd` or `.cs`, relative or `res://`) to `nodePath` in `scenePath`. Checks the script's native base type and loadability before saving. |
| `set_node_reference` | Sets an exported `property` on `nodePath` to `targetNodePath` in the same scene. Supports typed Node references and NodePath properties; rejects incompatible targets. |
| `set_main_scene` | Sets `application/run/main_scene` to `scenePath`, preserving other settings and comments. |
| `get_class_info` | Reflects a built-in `className` from the installed Godot version. Optional `section`: `properties` (default), `methods`, `signals`, or `enums`; `filter`, `includeInherited` (default true), and `limit` (default 100, maximum 500). Does not provide prose documentation. |
| `get_runtime_tree` | Reads the live debug session's scene nodes, classes and script paths. `maxDepth` defaults to 10 (maximum 20), `maxNodes` to 100 (maximum 200). Reports truncation and preserves pause state. |

Scene node paths use `root`, `.`, or a path beneath the root such as `root/Player`. Scene editing runs project constructors: use trusted projects. Mutating scene tools preflight script dependencies and verify that repacking preserves existing scripts. Unavailable scripts fail before scene saving. C# operations require a Godot **.NET executable and a built, loadable assembly**; a standard executable refuses C# edits instead of dropping attachments. GDScript attachment and safe rejection/preservation with standard Godot have integration coverage; positive .NET attachment still needs verification with a .NET installation.

`update_project_uids` imports the project before resaving and returns scene/UID counters. One-shot engine operations have bounded output, a 60-second deadline (version queries use 10 seconds), request cancellation and shutdown cleanup. `launch_editor` observes the first 1.5 seconds for errors or early exit, returns its diagnostics and distinguishes process startup from project readiness. `view_log` retains later errors.

## Protocol compatibility and sessions

The official MCP v2 server supports `2026-07-28` over stdio, including discovery and per-request metadata, while retaining `2025-11-25` initialization compatibility. Server instructions guide the workflow and tool annotations identify read and mutation operations.

For `2026-07-28`, `run_project`, `run_scene`, `launch_editor`, and `start_debug_session` return a `sessionId` in a final text content block. Pass it to subsequent log, input, pause, screenshot, runtime-tree and stop calls. Multiple sessions are independent. Supplying an existing handle replaces the previous process of that kind in that session. `close_session` stops its game/editor and releases the handle; stale handles are rejected. A server supports at most 16 explicit sessions at once. Older clients retain the existing default-session workflow, and may opt into explicit sessions by using handles returned by newer clients.

## Optional execution policy

Set `GODOT_ALLOWED_ROOTS` to permitted project/search directories, separated by the platform path-list delimiter (`:` on macOS/Linux, `;` on Windows). Canonical paths are checked, including symlinks. With no value, project selection remains unrestricted.

Set `GODOT_READ_ONLY=true` to allow metadata/discovery/log/reflection queries and process cleanup while rejecting resource writes and project execution, including tests and screenshots that start scenes. Existing runtime inspection is allowed. These controls restrict MCP requests; they are not an OS sandbox for project scripts. Hosts should retain their tool-approval controls.

### Windows and WSL

Use an executable file in `GODOT_PATH`, not its containing directory. The server passes JSON and paths as native argument arrays, including spaces and quotes. CI runs portable regression checks on Windows, macOS and Linux with Node 22.14 and 24; platform coverage does not imply all engine/render/.NET combinations are verified.

In WSL, use a Linux Godot binary and Linux project paths. Alternatively run both this server and Godot natively on Windows with Windows paths. Directly combining WSL project paths with a Windows `.exe` is rejected with an actionable error; binary-aware cross-environment path translation is not supported.

### Google Antigravity

Following [Google's MCP configuration guide](https://antigravity.google/docs/mcp), open **MCP Servers → Manage MCP Servers → View raw config** in the IDE, or use the CLI's `/mcp` manager. Add the server to `mcpServers` in your global `~/.gemini/config/mcp_config.json` or workspace `.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@grinry/godot-mcp"],
      "env": { "GODOT_PATH": "/absolute/path/to/godot" }
    }
  }
}
```

Refresh the server configuration. This is a local stdio server; it does not require an editor addon or OAuth.
