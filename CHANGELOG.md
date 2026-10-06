# @grinry/godot-mcp

## 0.3.0

### Minor Changes

- 1330694: Add scene inspection and transactional editing, runtime property inspection and frame stepping, and project overviews. Improve validation with targeted script checks and structured diagnostics.

## 0.2.0

### Minor Changes

- 2175528: Add safe script attachment, typed exported node references, main-scene configuration, installed-version ClassDB reflection and bounded live scene-tree inspection. Refuse unavailable script dependencies before scene writes, preserve script references during repacking and report UID update counters.

  Own finite Godot processes and POSIX descendants through timeout, cancellation and shutdown; prevent concurrent session closure from orphaning queued launches; isolate reflection from project autoloads; surface early editor launch errors and stabilize asynchronous input-log verification. Add optional project-root/read-only policies, stronger resource-path confinement including dangling symlinks and actionable WSL/texture diagnostics.

  Migrate to the official MCP v2 server for 2026-07-28 discovery and request envelopes, with explicit independent session handles and retained 2025-11-25 compatibility. Add protocol, authoring, policy and lifecycle regressions, cross-platform CI, and Antigravity configuration documentation.

  Addresses the valid remaining scope from Coding-Solo/godot-mcp issues #142, #106, #23, #101, #114, #57, #39, #98, #77, #135, #97, #102, #103, #37 and #73. Positive .NET attachment requires a loadable compiled assembly and remains a separate runtime verification requirement.

- 1c94d6f: Adapt verified upstream fixes for configured project names, res:// paths, UID scanning, typed node properties and scene ownership/cleanup. Upgrade the MCP SDK, remove unused Axios and require Node.js >=22.14.

  Add bounded project discovery, timed scene runs, GDScript validation, headless scene testing, preset export, inline one-shot screenshots and managed editor logs/shutdown. Retain final game output, serialize process replacement and verify termination. Add regression tests for lifecycle, paths and scene editing.

  Adapted from Coding-Solo/godot-mcp PRs #140, #131, #137, #104, #133, #18, #19, #105, #126, #123, #124, #100, #107 and #108.

  Add temporary live debug sessions with authenticated file IPC, paused-state screenshots and action/key/mouse input, plus a bounded GUT runner. Add MCPB builds and GitHub release attachments, Codex plugin metadata and Autohand setup documentation. These adapt #96, #69, #42, #75, #91 and #122 without permanent project modifications or unauthenticated TCP listeners.

### Patch Changes

- 165a415: Standardize source formatting and linting with Biome and enforce checks in CI and releases.

## 0.1.2

### Patch Changes

- Publish the grinry fork under @grinry/godot-mcp with updated repository links and automated Changesets releases.
