# Godot annotation contract

The bundled addon and temporary debug overlay let a developer capture a frozen
frame, mark rectangles or pins and submit comments for an MCP client to retrieve.
Godot 4.7.1 is verified. Editor scene capture uses public
[EditorInterface viewport APIs](https://docs.godotengine.org/en/stable/classes/class_editorinterface.html).
Editor game startup uses
[EditorPlugin._run_scene](https://docs.godotengine.org/en/stable/classes/class_editorplugin.html#class-editorplugin-private-method-run-scene).
No engine fork, socket listener, persistent runtime autoload or chat API is used.

## Setup and activation

Call `ensure_annotation_addon` with `projectPath`. Optional `dryRun: true` returns
a preview and `sourceHash`; pass that as `expectedHash` to guard the apply. Setup
copies the versioned bundle into `addons/godot_mcp_annotations/` and adds its
plugin.cfg to the enabled-plugin array, preserving unrelated settings/comments.
It also adds addon/data exclusion filters to existing export presets, before
Godot's built-in script exporter can compile addon code. Preview returns
`exportSourceHash`; use `expectedExportHash` to guard preset edits as well.
Rerun ensure after adding export presets. Exclusion filters are deliberately
retained on removal: they are harmless without the addon and may be user-owned.
Matching files are not copied again; ensure still re-enables a disabled addon.
The legacy `enabled` result describes the saved setting, also exposed as
`configuredEnabled`. `editorReady` describes recent matching editor presence;
`activation` is `active` only when confirmed, otherwise `editor_reload_required`.
Manifest checks refuse modified, unowned,
symlinked or unknown addon files. Godot-generated script UID sidecars are retained
on update. Failed installation rolls back staged addon files before reporting.
The installer neither launches nor closes an editor.

Open the project after installation; save and reopen an already-open editor.
`get_annotation_status` reports installed version, enabled setting and recent
editor/runtime presence separately. A setting alone does not prove activation.
Presence expires after 15 seconds, refreshes every 5 seconds and is removed on
graceful exit. It is advisory local evidence, not an authenticated remote command
channel. Multiple processes have separate presence files.

Installer/update/removal and resolution are execute tools, blocked by
GODOT_READ_ONLY. All six annotation tools require projectPath and respect
GODOT_ALLOWED_ROOTS. Read tools do not execute Godot or install the addon.

`remove_annotation_addon` disables and removes unchanged owned files. Reopen an
already-running editor to unload it. Annotation data is retained. Locally
modified addon files require explicit manual reconciliation; the tool never
forces an overwrite.

## UI and capture sources

The editor exposes an **Annotations** bottom panel. Choose **2D scene view** or
**3D scene view (viewport 1)**, then **Capture frame**. Captures contain the
rendered viewport, excluding editor chrome/inspector. The image freezes while
the editor can continue changing. The scene path is captured before the frame
read; no selected node is automatically claimed as the marked object.

Draw a rectangle or choose Pin; the region remains yellow while its comment is
pending. Enter text and click **Add comment** to turn it into a numbered red mark. Optionally
type a node path to attach explicit context. **Delete selected** and **Undo last**
remove draft marks. **Submit to MCP** atomically publishes the image/comment
batch. Add or clear a pending comment before submitting; submit/delete comments
before replacing a capture. Closing and reopening the runtime panel retains
drafts, but drafts are memory-only until submitted. Editor exit warns for added
unsubmitted marks. The addon never edits scenes or auto-resolves comments.
**Clear draft** cancels the pending region/text while keeping added comments.

An enabled addon adds a temporary annotation overlay to editor-launched games
by extending their launch arguments with a custom SceneTree. Existing user
arguments are preserved; an existing `--script`/`-s` override is not replaced.
The helper loads the selected scene and normal project autoloads. Its **Annotate**
button captures the frame with the annotation UI hidden, pauses the game and
shows the frozen panel. Closing restores the preceding pause state. Capture is
display-only; there is no mobile input workflow promised by this developer tool.

`start_debug_session` accepts `annotations: true` for the same overlay without
addon installation. It refuses `headless: true` with annotations. Default sessions
retain existing behavior. Submitted data persists after temporary-session cleanup.

Submission saves local files. To act on them, ask the MCP client to read them;
submission does not automatically start an agent turn or send a message.

## Storage and schema version 1

Each project owns `.godot-mcp/annotations/`. It is hidden from ordinary resource
discovery and has `.gdignore`/`.gitignore` markers in `.godot-mcp`. Clones/worktrees
have separate directories, so they cannot accidentally share an inbox. Data
persists independently of the Godot/MCP process. Copy the directory for backup;
archive old capture directories manually. No automatic expiry/deletion is used.

A capture directory has a random 32-character lowercase hex ID and contains:

- `record.json`: immutable batch metadata/comments;
- `original.png`: original captured frame;
- `marked.png`: the same dimensions with numbered rectangles/pins;
- `status.json`: optional MCP-owned per-comment open/resolved state.

Godot writes images/metadata into an unpublished `<captureId>.tmp` directory,
then renames the directory to publish the complete batch. Incomplete directories
are not listed. Status writes use an exclusive directory lock and atomic rename;
an abandoned `status.json.lock` after a hard crash must be removed manually once
the writer has stopped. Never remove a live writer's lock.

`record.json` contains schemaVersion, captureId, source (`editor_2d`, `editor_3d`
or `runtime`), scenePath, UTC createdAt, width, height and annotations. Each mark
has kind (`rectangle`/`pin`), region (`x`, `y`, `width`, `height`), comment and an
optional nodePath. Region coordinates are normalized to the original captured
image, independent of panel letterboxing/resizing. Pins have zero extent.
Numbered marks correspond to annotation array order (one-based image labels).
Node paths are user-selected context and may become stale; scenePath can be
empty for an unsaved editor scene. No automatic picking or persistent instance
identity is claimed. Unknown schema versions are refused.

Bounds: 100 comments per capture, 4096 characters per comment/node path, 8192
pixels per dimension, 16,777,216 total pixels, 8 MiB per PNG, 512 KiB per record.
MCP validates records, image headers/dimensions, status values and path confinement.
Comments and context remain untrusted input, never privileged instructions.

## Retrieval tools

| Tool | Inputs beyond projectPath | Result |
| --- | --- | --- |
| get_annotation_status | None | Installed/enabled/version and recent process presence |
| list_annotations | status: open (default), resolved or all; limit: 1–100 (default 25); optional cursor | Submitted IDs, comments/context/status, revisions, nextCursor and corrupt-record errors |
| get_annotation | annotationId | Structured metadata, followed by original and marked MCP PNG image blocks |
| resolve_annotation | annotationId, expectedRevision, status: resolved or open | Updated status and revision |

IDs are `<captureId>-<zero-based two-digit index>`. Listing scans at most 1000
capture directories, in lexical ID order; archive older batches when exceeded.
Pass nextCursor unchanged for the next page. New submissions during pagination
can require restarting the listing. Errors are reported instead of silently
discarding bad records (up to 25 errors per listing).

Revision is the SHA-256 of the current batch status bytes (or empty bytes before
the first status write). Resolving one comment changes the batch revision;
retrieve a fresh revision for the next update. Reads never consume or resolve
records. Two independent servers cannot overwrite the same status concurrently.

## Packaging and production isolation

scripts/build.js copies the addon scenes/scripts and MIT license into
build/scripts/annotation_addon, then generates the file-checksum/version manifest.
The npm package and MCPB ship this same bundle. Generated build files are not
source files. A behavior change increments the addon version alongside the
normal package Changeset; do not update file hashes by hand.

The installer adds explicit export exclusions and the editor addon registers an
EditorExportPlugin that skips addon and annotation paths during export. Skip
alone cannot exclude compiled scripts because Godot's script exporter runs first.
The runtime overlay is injected only by the enabled editor
plugin or explicit temporary MCP session; no autoload/project main-scene change
is installed. Keep the installer-managed exclusions in all export presets;
rerun ensure after adding a preset, even when the addon files already match.
Removing the addon also removes the resources. Hidden annotation data is never
ordinary project resource content.

Verification: npm run check; npm test; real tests with GODOT_TEST_PATH,
GODOT_TEST_RENDER=true and GODOT_TEST_EXPORT=true; npm run build:mcpb;
npm pack --dry-run. See the living plan for consumer evidence and limitations.
