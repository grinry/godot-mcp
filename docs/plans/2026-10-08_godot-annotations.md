# Godot annotations and automatic addon installation

Status: implemented locally; final verification recorded below; release pending approval.
Last updated: 2026-10-09.

## Goal

Let a developer capture a Godot editor view or running game frame, mark a
region, and attach a comment that an MCP client can retrieve with its image and
scene context. Bundle the editor addon in godot-mcp and install it on demand;
no manual addon download, copying, or plugin checkbox should be required.

## Ownership and repositories

| Repository | Responsibility | Branch |
| --- | --- | --- |
| godot-mcp | Addon, installer, annotation contract, storage, MCP tools, runtime bridge, packaging and tests | feature/godot-annotations |
| godot-client | Falkreach integration checks, developer runbook, export isolation and any necessary project integration | feature/godot-annotations |

The canonical plan and eventual annotation interface specification belong to
godot-mcp. Consumers are the bundled Godot addon/runtime helper, any compatible MCP client or agent, and godot-client as the first real project integration.
ai-toolkit needs no changes unless implementation demonstrates a reusable
orchestration requirement. No game-server, player-platform, gameplay protocol,
account API, authored-content schema, or catalog changes are planned.

Both feature branches were created from freshly fetched origin/main. The
original godot-client checkout has unrelated release changes and a local main
commit ahead of upstream; it remains untouched. Client work uses the separate
workspace worktree `.worktrees/godot-client-annotations`.
Each repository will have its own PR against main; add PR links here when made.

## Current behavior and evidence

- scripts/build.js copies src/scripts into build/scripts; the npm package ships
  build. Extend this packaging pattern rather than downloading addon code.
- start_debug_session launches a bundled script with a private authenticated
  file bridge. It installs no addon or autoload and opens no network listener.
- capture_screenshot already returns an inline image from an active session.
- Project configuration tools preserve unrelated values/comments and support
  dry-run/source-hash guards. Reuse the project writer for plugin enablement.
- GODOT_ALLOWED_ROOTS and GODOT_READ_ONLY govern tool access today.
- No annotation addon, installer, durable annotation API, or editor handshake
  currently exists. Existing runtime sessions are owned by MCP, not arbitrary
  games started with the editor's Play button.

## Scope and non-goals

First deliver a frozen-frame annotation panel with rectangle and pin tools,
comments, delete/undo, and an annotation list. Store the original image and draw
marks separately so MCP can return a clean image and a numbered marked image.
Use authored .tscn UI with GDScript behavior. Arrow/freehand tools can follow.

Support MCP-launched games first, then editor scene views and editor-launched
games through the addon. Keep capture source explicit; do not pretend a game
viewport screenshot includes the editor chrome or inspector.

Non-goals: a Godot engine fork, whole-desktop screenshot permissions, remote
collaboration, automatic agent turn submission, automatic code edits on submit,
mobile annotation controls, continuous video, or a universal scene-node picker.
Live drawing over a moving scene and automatic 3D picking are deferred.

## Intended workflow

1. The user asks for annotations in a selected project.
2. The MCP client calls ensure_annotation_addon(projectPath) for editor use, or
   starts an annotation-capable temporary debug session for runtime-only use.
3. Installation validates the project and existing addon, copies bundled files,
   enables the addon, and reports installation and activation separately.
4. The developer captures a frame in Godot, marks regions and writes comments.
   The game may continue running while the frozen image is annotated.
5. Submit saves the complete annotation batch. It does not send a chat message.
6. The user asks their MCP client or agent to read the annotations. It lists submitted records,
   fetches images/context, and makes requested changes.
7. Resolving a record is an explicit operation; retrieval never consumes it.

## Annotation interface proposal

Define schemaVersion 1 and stable IDs for captures, batches, and annotations.
A capture contains project identity, source (editor_2d/editor_3d/runtime), scene
resource path when known, UTC timestamp, original image dimensions, viewport
dimensions, and optional runtime session/camera context. Distinguish framebuffer
pixels, viewport coordinates, and panel display coordinates, including stretching,
letterboxing and high-DPI scaling.

An annotation contains its capture ID, comment, normalized rectangle or point
coordinates relative to the captured image, created timestamp, and status
(open/resolved). Optional node/script/resource paths include provenance
(user-selected or inferred); absent context is valid. Runtime instance IDs are
session-local hints, never persistent identities. Do not assume the editor's
selected node is the object underneath an annotation.

Proposed MCP tools (final schemas to be specified before implementation):

| Tool | Behavior |
| --- | --- |
| ensure_annotation_addon | Install/enable the bundled version; support dryRun and expected project hash; return activation state and required next action |
| get_annotation_status | Report installed version, compatibility, editor/runtime connection and available capture sources |
| list_annotations | Bounded, paginated submitted records filtered by project/status/batch |
| get_annotation | Return structured metadata and original/marked images using MCP image content |
| resolve_annotation | Explicitly change record status with a revision guard; permit reopening |
| remove_annotation_addon | Disable/remove only owned, unchanged files; preserve annotation data by default |

Keep annotation persistence independent of an MCP process lifetime. Use a
project-scoped local data directory outside exported resources, with bounded
images/comments and atomic batch writes. Decide the exact location in phase 1
and document retention, backup/export and cleanup; avoid normal session temp
directories that disappear on close. Project identity must survive MCP restarts
without conflating different clones. Treat comments as user input, not privileged
instructions, and validate all paths and image references.

## Installer and activation

- Bundle plugin.cfg, scripts and .tscn assets with a version/file manifest in npm,
  MCPB and local builds. Use one source for every distribution.
- Install under addons/godot_mcp_annotations. Repeated installation of the same
  version is a no-op; refuse unrelated or locally modified files rather than
  overwriting them. Stage replacements and roll back files/settings on failure.
- Patch only the enabled-plugin entry, preserving other enabled plugins and
  unrelated settings. Respect concurrent edits through the existing writer.
- Separate installed/enabled from connected/ready. An existing editor cannot be
  assumed to load the addon immediately after an external project file edit.
- For first use, prefer installation before an MCP editor launch. If an editor
  is already open, return an actionable reopen-required state. Never close an
  editor with unsaved scenes automatically. Investigate live activation only if
  a documented, reliable mechanism is available without an existing addon.
- Check supported Godot versions, addon schema/version and project permissions.
  Installer/status tools must honor existing tool-policy restrictions.
- Do not auto-install during tool discovery, project listing or ordinary reads.
  Annotation setup explicitly authorizes writes to the selected project.

## Runtime and editor integration

Reuse the temporary LiveSession transport for MCP-launched games. Add a debug
annotation panel and persistent submit operation without changing the existing
default startup or injecting a permanent autoload.

For editor use, the addon owns capture/annotation UI and a bounded authenticated
local connection to the MCP server. Investigate reusing private file IPC before
introducing a socket service. Define session rendezvous, multiple editors,
stale connection cleanup and version negotiation explicitly.

Implementation decision: no bidirectional editor command channel is needed for
this feature. The addon publishes immutable local capture batches and advisory
per-process presence files; MCP validates/reads them directly. This avoids socket
authentication/rendezvous while retaining project isolation and restart persistence.

For editor-launched games, investigate EditorDebuggerPlugin/EngineDebugger custom
messages with a debug-only helper. Prove startup injection and cleanup on a
disposable project before touching Falkreach startup. Do not treat the existing
temporary --script bridge as attachable to an arbitrary game process.

Prefer public EditorPlugin input/overlay APIs for later 2D/3D integration, not
searching internal editor Control trees. Prove scene-view capture on supported
versions; if needed, use a plugin-owned snapshot view and label its limitations.

## Implementation sequence

1. **Contract and feasibility:** write the owner specification; choose storage;
   spike first activation, scene-view capture, debug helper injection, and frame
   coordinate mapping in a disposable Godot project. Record verified version
   bounds and any explicit editor-reopen limitation.
2. **Storage and MCP retrieval:** versioned records, atomic submit, bounded list,
   image response, resolve/reopen and restart persistence. Verify tool policy and
   project isolation before building interactive UI.
3. **Bundled addon and installer:** authored snapshot panel, manifest, dry-run,
   guarded install/update/remove, enablement, readiness handshake and packaging.
4. **Temporary game integration:** extend existing debug sessions to capture and
   annotate frozen runtime frames; consume drawing input only in annotation mode.
5. **Editor integration:** expose editor captures and editor-launched game
   support once the feasibility checks pass. Clear context on scene/session
   changes and retain immutable capture context for saved annotations.
6. **Falkreach consumer verification:** add a concise client runbook linking the
   owner spec; test real portrait UI, installation and exports. Add project code
   only if necessary. If vendoring addon code, record MIT provenance and license
   in the client attribution ledger; do not silently duplicate ownership.
7. **Release preparation:** README and CONTRIBUTING updates, changeset for MCP
   behavior, npm/MCPB contents checks and reviewable PRs. Publishing is separate.

## Verification matrix

| Area | Required evidence |
| --- | --- |
| Installer | Fresh install, repeated install, enabled-plugin preservation, modified-file refusal, invalid/out-of-root paths, read-only policy, failed-install rollback, safe removal |
| Lifecycle | Fresh editor launch, already-open editor status, readiness/version mismatch, editor/game stop, MCP restart and multiple project isolation |
| Persistence | Atomic batch submission, revision conflicts, pagination, corrupt/incomplete records, oversized input/image bounds, no data loss on process exit |
| MCP | Discovery, schemas, original/marked image content, structured context, explicit resolve/reopen, no retrieval side effects |
| Coordinates | Portrait 720x1280, resized window, letterboxing, high-DPI display, correct numbered regions on original capture |
| Godot UI | Capture, mark, comment, undo/delete and submit; gameplay receives normal input outside annotation mode and no drawing input inside it |
| Editor views | Explicitly supported 2D/3D sources and clear unsupported-source errors; no internal editor hierarchy dependence |
| Exports | Annotation UI/transport/data absent from production startup and export artifacts; existing desktop/web behavior preserved |
| Packaging | npm run check, npm test, npm run build:mcpb and npm pack --dry-run include all required assets; execute real Godot tests with display rendering |
| Client | Repository-owned focused verifier plus manual addon/game smoke checks; export checks when integration affects export contents |

Use deterministic installer/storage regression tests and disposable fixtures.
For human-driven annotation checks, wait for the user's response; do not resolve
input via an autoResolutionMs timeout. Report unavailable checks accurately.

## Compatibility, rollout and rollback

All MCP tools and annotation capability negotiation are additive. Existing
runtime tools continue to work without an addon. Unsupported record schemas or
addon versions produce clear errors, never silent migrations or record deletion.
Bundle server/addon versions together; support or explicitly reject older addons
before an upgrade. Upgrade only manifest-owned unchanged files.

Rollout: disposable project → local MCP build with client worktree → package
verification → approved MCP release → client runbook/integration aligned to that
release. Do not require gameplay/server deployment. Track separate PRs here.

Rollback: disable the addon, restore previous owned files/plugin setting, and
return to ordinary MCP runtime sessions. Preserve annotation records for export
or a compatible version. Restore only installer-owned edits, not a whole older
project.godot over subsequent user changes. Stop only owned helper processes.

## Progress and open decisions

- [x] Read workspace and repository guidance and inspect existing MCP seams.
- [x] Fetch both upstream main branches and create feature branches.
- [x] Preserve unrelated client changes using a separate client worktree.
- [x] Create canonical plan and consumer planning handoff.
- [x] Specify contract and resolve phase-1 feasibility questions.
- [x] Implement installer, snapshot UI, persistence, MCP retrieval and runtime/editor integration.
- [x] Verify client integration, real rendered captures and exported-pack isolation.
- [ ] Release after separate approval; no commit/push/publish has been performed.

Resolved decisions: project-local `.godot-mcp/annotations` storage; Godot 4.7.1
verified; public 2D/3D viewport capture; editor `_run_scene` argument hook with a
temporary SceneTree; one-way local batch submission instead of an editor RPC channel.
Other engine versions remain unverified. Existing custom --script launches are
preserved and do not receive this overlay. First installation in an open editor
requires saving/reopening; automatic restart would risk unsaved work.
Deferred: automatic chat submission, live overlays, automatic 3D picking,
arrow/freehand tools and multi-user collaboration.

## Implementation and discoveries

- Added six MCP tools with project policy enforcement, guarded file installation,
  checksum ownership, safe removal, bounded reads and revision-checked resolution.
- Authored the shared snapshot UI in .tscn scenes, including rectangle/pin marks,
  explicit node context, comment list, undo/delete and clear-pending controls.
- Original and numbered marked PNGs plus immutable metadata publish as one batch;
  submitted records survive game/MCP shutdown. Runtime annotation pauses the local
  game and restores its preceding pause state. Pending drafts survive panel close.
- Reused the existing LiveSession for opt-in temporary annotation sessions; defaults
  remain addon-free. Actual editor 2D/3D capture and editor launch-hook arguments
  were exercised in disposable projects.
- Godot's built-in script exporter can emit .gdc files before a custom skip hook.
  The installer therefore adds explicit exclusions to every existing export preset,
  guarded by exportSourceHash/expectedExportHash. Exclusions remain on uninstall;
  rerun ensure after adding a new preset. Real exported-pack inspection confirmed
  addon scripts/scenes and local annotation records are absent.
- The fresh client worktree initially lacked imported global class metadata, causing
  unrelated ProtocolConstants/ProtocolSerializer parse diagnostics. The CI-equivalent
  import fixed this; the client-owned focused annotation verifier then passed.
- Temporary client addon installation was removed after verification. Client changes
  are the developer runbook, opt-in verifier/UID, documentation links, provenance,
  and exclusion filters in its seven existing export presets. No startup/autoload,
  main scene, gameplay/network interfaces or vendored addon source changes remain.
- npm/MCPB contain all addon scenes/scripts, generated manifest and MIT license.
  The desktop bundle tool parity check exposed 62 tools.

Verification evidence: npm run check/build; npm test (ordinary suite passed);
real Godot annotation tests including rendered runtime/editor captures, launch
arguments, actual MCP bridge retrieval and exported PCK inspection; client
`tools/run_verifier.sh --script tools/verify_godot_annotations.gd` passed.
`npm run build:mcpb` and `npm pack --dry-run --ignore-scripts --json` passed with a
temporary npm cache. Initial parallel full real-engine suite had one existing
300 ms startup-timing assertion fail; that test passed alone. The final serial
real-engine suite passed: 58 tests, zero failures, one unrelated GUT test skipped.
GUT-specific tests require an external GUT
installation and are outside this feature.

## Enablement follow-up

The user reported that initial installation did not enable the live Plugins
checkbox. A disposable running editor reproduced the distinction: ensure wrote
the enabled setting, but EditorInterface.is_plugin_enabled still returned false
until reopen. The old enabled:true result described saved configuration and was
easy to mistake for live activation. Reopening enabled the addon without any
manual checkbox action.

Ensure now shares the plugin setting patcher with three new tools:
get_editor_plugins, enable_editor_plugin and disable_editor_plugin. It explicitly
reports configuredEnabled, editorReady and activation, and always patches a
disabled installed addon even if its files already match. The legacy enabled
field remains the saved setting for compatibility. Matching fresh presence
confirms active; absent/stale presence requests editor reload.

Generic plugin tools have root/policy enforcement, config/script validation on
enable, previews, hash guards, preserved unrelated values and stale-entry removal
on disable. They do not run project scripts or toggle an already-open editor's
checkbox remotely. A live editor command bridge remains outside this change;
no automatic closing/restart risks unsaved work.

Verification: disabled-existing-addon regression, preserved settings and policy
tests, actual MCP discovery/calls, and a real running/reopened Godot editor
reproduction. The ordinary full suite passed 41 tests with 22 optional engine
tests skipped; targeted real-engine evidence is recorded separately. No commits
or pushes were made.

The permanent real-engine regression exercises ensure while an editor is open,
checks that it reports pending rather than active, then reopens and verifies
EditorInterface.is_plugin_enabled is true without a checkbox click. It passed.
The main client's addon also reported fresh active presence after this fix.
The unattended rendered editor fixture initially timed out while idle; forcing
redraws in that fixture (without changing global editor preferences) made its
2D/3D capture check pass. MCPB was rebuilt and verified with 65 tools.
Final focused real-engine and plugin-tool run: 17 tests passed, zero failures or
skips. Biome and diff checks passed; no debug instrumentation remains.

## Draft visibility follow-up

Addon 1.0.1 retains released rectangles and pins in yellow while comments are
pending. Added comments become numbered red marks; clearing the pending draft
removes its yellow mark without removing added comments. Draft coordinates stay
normalized, so resizing/letterboxing still maps to the captured image. The drawn
kind is retained even if the tool selection changes before adding the comment.
The shared panel applies this behavior to editor and running-game annotations.

A rendered pixel regression reproduced the disappearing rectangle before the
fix, then passed for released rectangles/pins, the red added state and clearing.
Updated the MCP-managed addon in the main client checkout; no game/editor was
closed automatically. Restart a running preview to pick up its new scripts.
All 15 annotation checks passed with real Godot rendering/export enabled;
the ordinary suite, Biome, diff checks and rebuilt MCPB also passed.

## MCP client compatibility

The annotation UI and contract use client-neutral language. Any compatible MCP
client or agent can install the addon, retrieve comments and screenshots, and
resolve annotations through the same tools. No client-specific API is required.

## Reported runtime startup layout error

The user reported two non-finite Control `set_begin` errors, the first from
`game_session.gd:21` while attaching the runtime annotation overlay. A rendered
client launch through that same wrapper (60 and 300 frame limits), a minimal
stretched 720x1280 project, and a zero-size startup viewport did not reproduce
the reported error. A forced singular canvas transform produced a different
`affine_invert` error and was discarded; it is not evidence for this bug.
No speculative fix or unrelated regression test was retained. The user confirmed a separate window. Four further bounded client launches
(1x1, 320x240, 1508x1279 and 720x1280), a debugger-enabled launch, and actual
editor main-scene/current-scene Play launches also did not reproduce `set_begin`.
The separate editor preview window uses `--embedded` internally. The editor was
opened for those checks and the test games were stopped. Awaiting whether fresh
Play launches still reproduce it consistently or it appeared only after addon
installation/update; no startup-layout fix is claimed.

## Duplicate game startup and transition crash fix

Addon 1.0.2 fixes a reproduced null SceneTree crash during world entry. Godot
already loads the main/selected scene before the wrapper's deferred startup;
the wrapper previously instantiated a second copy. Both startup instances
could subscribe to join events and queue transitions. The first transition
removes the second caller from the tree, causing the reported `data.tree` null
and `change_scene_to_file` invalid-call errors.

The editor wrapper now reuses the engine-loaded scene, with manual loading only
when none exists. The shared temporary debug-session launcher supplies its
selected scene via `--scene`, and its bridge also reuses that scene. Regression
coverage reproduces duplicate startup and the exact null-tree transition error
before the fix, then verifies one startup, a successful transition, and retention
of the annotation overlay. The MCP capture test now configures a different main
scene and proves only the requested debug scene starts.

The real Godot annotation/plugin suite passes all 19 tests. The local client
addon has been upgraded through ensure; its only local script modification was
tab indentation, confirmed byte-equivalent after normalization, and preserved
in a temporary backup before applying the managed update. No changes to the
client's gameplay or account/network interface are needed for this fix. The
earlier non-finite `set_begin` errors have not been reproduced or claimed fixed.

Final verification for the startup fix: the full serial real-Godot MCP suite
passed 65 tests with zero failures (one optional GUT integration skipped).
The client's network-disabled `verify_bootstrap_menu_scenes.tscn` passed.
Biome, diff whitespace, npm package inventory and desktop bundle validation
passed; the bundle still exposes 65 tools.
