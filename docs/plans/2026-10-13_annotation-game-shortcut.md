# Annotation game shortcut

Status: implemented on `feature/annotation-shortcut`; review and release pending.
Last updated: 2026-10-13.

## Goal

Editor-launched games must not show the always-visible **Annotate** button in
the top-left corner. Open the runtime annotation panel with a keyboard
shortcut instead, defaulting to Cmd+Shift+A (Ctrl+Shift+A off macOS), and let
the developer change it from the editor's **Annotations** panel.

## Ownership and compatibility

godot-mcp owns the addon, its runtime overlay and the
[annotation contract](../domains/annotations.md). The change is local to the
bundled addon (version 1.0.2 to 1.1.0) and the `start_debug_session` description.
Annotation storage, record schema version 1, MCP tool inputs/outputs and the
installer manifest format are unchanged.

Consumers: any project with the addon installed, including godot-client.
Existing installations keep the 1.0.2 button until `ensure_annotation_addon`
updates them; the managed update replaces the addon files and preserves Godot
UID sidecars. godot-client tracks the addon, so its update is a separate
godot-client `feature/annotation-shortcut` branch (addon 1.1.0 plus the
engine-generated `shortcut.gd.uid`), recorded in its
[annotation integration plan](https://github.com/falkreach/godot-client/blob/main/docs/plans/2026-10-08_godot-annotations.md).
No game-server, player-platform, gameplay protocol, account API or
authored-content work is needed.

## Decisions

- The overlay draws nothing until the shortcut is pressed. The same shortcut
  closes the panel. The game prints the active shortcut at startup so the
  hidden feature remains discoverable.
- The shortcut is a per-user Godot editor setting rather than a project setting:
  key bindings are personal, should follow the developer across projects and
  worktrees, and must not create project.godot diffs. The setting is erased while
  the default is used.
- Games cannot read editor settings, so the plugin passes the normalized value
  as a user argument from `_run_scene`, next to the existing scene argument.
  `start_debug_session` uses the default because MCP cannot read the editor's
  per-user settings.
- A portable `CmdOrCtrl+Shift+A` text form uses Godot's command/control
  autoremap, so a saved setting behaves the same on macOS, Windows and Linux.
- A shortcut needs a modifier unless it is a function key, so a single gameplay
  key cannot be taken over by accident.
- Recording consumes key presses in the editor's `_input` so editor shortcuts,
  such as Instantiate Child Scene, do not run while a new combination is captured.

## Verification

- `npm run check` and `npm test` pass.
- Real Godot 4.7.1 annotation suite with `GODOT_TEST_RENDER=true`: 16 passed, the
  export test skipped (needs `GODOT_TEST_EXPORT=true`). New coverage parses valid
  and invalid shortcuts, records from key events, cancels on Esc/hide, toggles
  the runtime overlay and pause by shortcut only, ignores echo and non-matching
  modifiers, and proves the editor launch argument reaches the game overlay.
- A rendered panel check confirmed the toolbar layout in idle and recording states.

Live check in godot-client (Godot 4.7.1, macOS, game embedded in the floating
Game workspace), after updating its addon with this branch's installer:

- Recording captured Cmd+Shift+A without triggering the editor's own
  Instantiate Child Scene shortcut.
- A recorded Ctrl+Shift+K reached the next launch: the game printed it, ignored
  Cmd+Shift+A, and opened/closed the frozen panel with Ctrl+Shift+K.
- After **Reset**, the next launch opened the panel with Cmd+Shift+A, **Close**
  returned to the game, and no custom editor setting remained after exit.
- godot-client's `verify_godot_annotations.gd` verifier passed.

Not checked by hand: a game in a separate, non-embedded window. That path
receives OS key events directly, as in the automated tests.

## Rollout

1. Review and merge the godot-mcp PR, then release through the Changesets PR.
2. Then merge the godot-client PR with addon 1.1.0; developers reopen the
   editor after pulling it. Merging it first is not broken, but ensure from the
   published 0.5.0 package would replace 1.1.0 with its bundled 1.0.2, and
   get_annotation_status would not report editor readiness for 1.1.0.
   Annotation retrieval is unaffected because storage schema 1 is unchanged.
3. Roll back the client by reverting its PR; roll back the owner by reverting
   this PR, after which ensure reinstalls addon 1.0.2.
