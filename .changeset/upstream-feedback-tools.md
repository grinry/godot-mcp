---
"@grinry/godot-mcp": minor
---

Adapt verified upstream fixes for configured project names, res:// paths, UID scanning, typed node properties and scene ownership/cleanup. Upgrade the MCP SDK, remove unused Axios and require Node.js >=22.14.

Add bounded project discovery, timed scene runs, GDScript validation, headless scene testing, preset export, inline one-shot screenshots and managed editor logs/shutdown. Retain final game output, serialize process replacement and verify termination. Add regression tests for lifecycle, paths and scene editing.

Adapted from Coding-Solo/godot-mcp PRs #140, #131, #137, #104, #133, #18, #19, #105, #126, #123, #124, #100, #107 and #108.

Add temporary live debug sessions with authenticated file IPC, paused-state screenshots and action/key/mouse input, plus a bounded GUT runner. Add MCPB builds and GitHub release attachments, Codex plugin metadata and Autohand setup documentation. These adapt #96, #69, #42, #75, #91 and #122 without permanent project modifications or unauthenticated TCP listeners.
