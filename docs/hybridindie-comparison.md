# Comparison with hybridindie/godot-mcp

Research date: 2026-10-06. Last updated: 2026-10-06. This living document tracks implementation in this checkout, not published package availability. The competitor comparison is based on documentation and source, not an end-to-end verification of its tools.

## Implementation tracker

| Area | Our status | Remaining difference / next work |
| --- | --- | --- |
| Saved scene transactions | Implemented before this comparison | Inherited scenes and editing instance contents remain unsupported. |
| Scene instancing and duplication | Implemented and verified | `instance_scene` / `duplicate_node` also work inside `modify_scene`. Duplication refuses instances, unique-name nodes, external node links and uncertain embedded references. Subtree extraction remains planned. |
| Generic resource inspection/creation/editing | Implemented and verified | `get_resource_info`, `create_resource`, `set_resource_properties` cover built-in `.tres`/`.res` resources and supported typed properties. Custom resource creation, collections, transforms and specialized resource graphs remain planned. |
| Reusable gameplay scenarios | Implemented; headless and rendered checks passed | `run_playtest` queues inputs at stepped frame boundaries, asserts state and returns screenshots/diagnostics, then stops the game. Screenshot baseline comparison is implemented in the current follow-up branch with `compare_screenshot`; input recording and stress testing remain planned. |
| Performance monitoring and property sampling | Snapshot and sampling implemented; targeted checks passed | `get_performance_monitors`, `sample_performance` and `sample_node_properties` provide bounded evidence and summaries. Custom monitors, passive capture and full profiling remain missing. |
| Settings / autoload / InputMap editing | Implemented; targeted checks passed | Eight tools preserve comments, unrelated entries and autoload order with previews/hash checks. Autoload validation covers names/paths, not script inheritance, compilation, global-class conflicts or .NET compatibility. Unsupported input event variants remain read-only. |
| Live editor / native undo | Missing, optional extension planned | Selection, unsaved scenes and editor UndoRedo need an editor bridge. |
| Breakpoint debugger | Missing | SceneTree pause/frame stepping exist; script breakpoints, call stacks and local variables do not. |
| Specialized authoring and analysis | Partial | Basic node/property authoring and dependency overview exist; animation, TileSet, audio bus, shader graph tools and impact analysis remain missing. |
| API contracts | Improved and verified | New tools declare output schemas; playtest runtime errors have stable codes. Tool specifications identify destructive operations, distinguishing them from ordinary execution/mutation. Legacy output schemas/errors remain incomplete. |

Statuses become implemented only after code and relevant checks are complete. Verification results and limitations are recorded below as work progresses.

### Godot annotations

2026-10-08: added a bundled, automatically installed editor addon, opt-in temporary
game overlay, and six project-scoped annotation tools. Original/marked screenshots
and comments persist locally for MCP retrieval and revision-guarded resolution.
Real Godot 4.7.1 checks cover rendered 2D/3D/game captures, editor activation/launch,
actual MCP retrieval, coordinates/pause restoration and export exclusion. Client
integration checks pass. See the [contract](domains/annotations.md) and
[living plan](plans/2026-10-08_godot-annotations.md). First activation in an open
editor needs save/reopen; custom SceneTree launch overrides are preserved;
automatic chat submission and live overlays remain deferred.

Enablement follow-up: three generic plugin configuration tools now list,
enable and disable saved plugin settings. Ensure re-enables existing disabled
addons and distinguishes configured enablement from confirmed editor presence.
An already-open editor still needs save/reopen; no live checkbox RPC is claimed.

### Verification log

- 2026-10-06, first batch on `feat/authoring-playtest-foundation`: TypeScript build and targeted real-Godot 4.7.1 tests passed. Scene duplication preserved scripts, ownership, groups, internal NodePaths/exported Node references and persistent signals after reload. Scene instancing preserved the source-scene link and refused recursion. Resource tests covered text/binary files, external material references, dry runs, stale hashes, invalid properties, symlink confinement and concurrent create/write refusal.
- Gameplay tests passed with action/key input, exact physics-frame counters, approximate vector assertions, assertion failures, missing properties, process cleanup and an inline rendered screenshot. A first test exposed buffered input arriving one frame late; queued events now flush at the resume boundary. Portable tests cover cancellation/deadlines and reject truncated assertion values. Performance snapshot tests cover timestamps, units, paused state and headless unavailable metrics.
- Full real-engine regression: **38 passed, none skipped** with Godot 4.7.1, rendering, Web export templates and GUT, on Node 24 and the declared minimum Node 22.14. Final Node 24 run passed all 38 after annotation/incomplete-log fixes; the affected portable tests additionally passed on Node 22.14. Modern-client checks include playtest session handles, retained final logs and handle closure. Resource tests also verify unchanged UIDs and refusal of unique-name duplication.
- MCP Inspector 2.9.0: strict discovery has **zero schema errors/warnings**, and 13 CLI calls verified success/invalid-input cases for scene/resource/playtest tools and missing-session rejection for monitors. Successful paused monitor reads are covered by the live MCP regression. Desktop bundle validation confirms **46 tools** with matching discovery/manifest metadata. Build, Biome and `npm pack --dry-run` passed; package contents include the executable, engine scripts, README and MIT license. A minor changeset records the additions; versions were not changed.
- 2026-10-06, second batch: **43 passed, none skipped** on both Node 24 and Node 22.14 with real Godot 4.7.1, rendered screenshots, Web export and GUT. Configuration tests cover comment/CRLF preservation, shared write serialization, dry runs/stale hashes, autoload order and isolation, supported binding round trips and fresh-launch application. Sampling covers exact resumed physics callbacks, scalar/vector summaries, bounded evidence, pause retention, invalid inputs, deadlines and independent modern-client session handles.
- MCP Inspector 2.9.0 verified 13 configuration/sampling calls (success and invalid-input/missing-session cases), plus strict discovery with zero schema warnings/errors. Inspector exposed an all-actions nullable-key output mismatch, corrected and rechecked. Successful sampling is exercised through live MCP regressions. Desktop bundle validates **56 tools**; build, Biome, diff checks and package contents passed. A second minor changeset records this batch.
- These entries describe working-tree implementation, not a release. Positive .NET support and native Windows/Linux engine behavior have not been verified in this batch.

### PR review

- 2026-10-06: separate standards and behavior reviews found two actionable configuration issues: the input schema excluded nested arrays supported by the decoder, and input-action reads could omit stored fields while labeling the binding supported. Both are corrected. Reads now verify reconstruction against stored event properties and mark unrepresentable shapes unsupported; regression coverage includes key location, mouse double-click and fractional joypad-axis values. Small duplication heuristics did not justify broad refactoring. Follow-up behavior review found no remaining actionable concerns.
- Final review validation: 43 real-engine tests passed with rendering, export and GUT when run with test files sequenced (`--test-concurrency=1`); the preceding overlapping run hit existing startup/input timing failures. Affected configuration tests passed on Node 22.14; strict Inspector discovery and 14 affected tool calls passed, including nested arrays. Rebuilt desktop bundle validates 56 tools; build, Biome and diff checks pass.

### README audit

- 2026-10-06: all 56 registered tools are named in README. Expanded the top Features list for validation/export, live feedback/input, reflection, sessions and transactional authoring. Clarified repository versus published-package availability, Godot 4 requirements, sampling session handles and the execution-policy limits on runtime/property/configuration reads.

### Screenshot comparison implemented

- Separate standards and behavior reviews against merged `main` found no actionable issues in the screenshot-comparison follow-up.

- Add `compare_screenshot` playtest assertions with project-confined reference PNGs, per-channel tolerance, allowed changed-pixel ratio and inline diff evidence. Snapshot and validate baselines before replacing the selected game; never create or update reference files. The 47-test real-Godot suite passes; pixel tests cover RGBA/alpha differences, inclusive tolerance boundaries, dimension mismatches and immutable reference snapshots. Rendered MCP tests verify matching captures and preservation of existing games on missing references.

- Follow-up verification: 47 tests passed with real Godot 4.7.1, rendering, Web export and GUT on Node 24; all seven affected tests pass with real rendering on Node 22.14. Portable checks cover preflight confinement/PNG limits, assertion budgets, cancellation/deadlines and temporary-file cleanup. MCP Inspector verified six rendered success/failure calls, including pixel mismatch evidence, subsequent-step execution, missing/invalid references and dimension mismatch. Strict discovery has zero schema warnings/errors; desktop bundle validates 56 tools and package contents include the comparator script. No baseline-update operation is exposed. Comparisons use RGBA8 channel differences, not perceptual analysis; references/captures are bounded to 8 MiB, 4096 pixels per axis and four million pixels.

### Next implementation batches

1. Subtree extraction with explicit multi-file failure/rollback semantics, then broader resource value types.
2. Richer resource/configuration value types, input event variants and deeper autoload compatibility validation.
3. Recorded input sequences, richer visual checks (regions/perceptual comparison) and custom/passive monitor capture.
4. Optional editor bridge for selection/unsaved state/native undo, followed by a separate breakpoint debugger.

### Second batch implemented — configuration and sampling

- Preserve the first batch's uncommitted changes on `feat/authoring-playtest-foundation`.
- Add project-setting, autoload and InputMap tools with comment/multiline-preserving atomic edits, previews and source hashes. Use an isolated engine for serialization/config validation rather than starting the project's autoloads.
- Add paused-session frame-based monitor/property sampling with bounded evidence, units, timestamps and numeric/component summaries. Sampling advances the game and leaves it paused; it is not passive observation or deterministic replay.
- Targeted real-Godot configuration, sampling, playtest and workflow checks passed: 15 tests. Full regression/client/package verification passed (details below). Configuration parses without starting project autoloads; sampling preserves pause state and timeout cleanup stops the game.

## What the other MCP adds

Hybridindie's design centers on a live editor addon and WebSocket bridge. Its README advertises 193 tools across 29 categories, with most categories disabled until requested. Selected nodes, unsaved scene state and editor undo are consequently accessible. Runtime inspection requires an additional probe. These are useful architectural differences, rather than a reason to compete on tool count. [Upstream README](https://github.com/hybridindie/godot-mcp/blob/main/README.md)

Its contracts document scene instancing, duplication and subtree extraction; generic resource authoring; project settings, autoload and InputMap editing; input sequences, assertions and screenshot comparison; runtime Performance monitor snapshots and property sampling; debugger breakpoints, execution stepping, stack frames and variables. Dedicated authoring categories cover animation, tilemaps, themes, audio, navigation and visual shaders. Analysis includes reverse references, dependency cycles and integrity checks. These are documented capabilities, not independently demonstrated here. [Upstream contracts](https://github.com/hybridindie/godot-mcp/blob/main/docs/tool-contracts.md)

## What we already have

Our existing surface is considerably stronger than basic launch-and-edit tooling:

- Scene inspection and transactional property, rename, reparent, removal, group and signal edits are implemented. `modify_scene` validates ordered operations and saves once through atomic replacement; `dryRun` and `expectedHash` support previews and stale-change rejection. Inherited scenes and edits inside scene instances are deliberately refused. [Scene tools](../src/scene-tools.ts), [documented restrictions](../README.md#project-inspection-and-transactional-editing)
- Runtime sessions already support input, screenshots, tree/property inspection, pause and frame stepping. Explicit handles support independent sessions. The temporary authenticated file bridge needs no installed addon, project autoload modification or listening network port. Frame stepping follows Godot's process behavior and does not promise deterministic replay. [Runtime tools](../src/runtime-tools.ts), [runtime documentation](../README.md#live-visual-feedback-and-input)
- Validation, scene tests, GUT execution and exports already exist. We can test gameplay without adding a second general-purpose test framework. [Workflow tools](../src/workflow-tools.ts)
- Project overview reads settings, autoloads, input actions and text-resource dependencies; reflection exposes installed-engine class metadata. Configuration tools now preview and edit stored settings, autoload registrations and supported InputMap bindings. Deeper compatibility validation and dependency impact analysis remain missing. [Project overview](../src/project-overview.ts), [authoring tools](../src/authoring-tools.ts)

## Recommended priorities

### 1. Finish the scene and resource authoring foundation

Implemented: scene instancing, conservative subtree duplication and generic built-in resource creation/inspection/editing. Agents can assemble reusable scenes and configure supported materials/shapes through Godot. See [scene tools](../src/scene-tools.ts) and [resource tools](../src/resource-tools.ts).

Reuse our typed values, path confinement, previews and content-hash checks. Keep ownership and instance boundaries explicit. Extraction writes multiple files, so its failure and rollback contract needs particular care. Settings, autoload and InputMap editors that preserve unrelated configuration are also implemented; richer typed values and deeper compatibility validation remain.

### 2. Add reusable playtest scenarios

Implemented as [run_playtest](../src/playtest-tools.ts): start a scene, queue input, advance frames, assert property values with tolerances, capture evidence and return a structured pass/fail report. The owned game stops after success, failure or cancellation, releasing held inputs and temporary IPC. Reports refuse to claim success when game logs truncate.

State assertions, input sequences and PNG screenshot baselines with channel/changed-pixel thresholds are implemented. Region masks, perceptual comparison and input recording remain planned; rendering differences must not become unexplained failures. A recorded input sequence is useful automation, but should not be described as deterministic replay. Reuse GUT for tests requiring project-specific logic.

### 3. Add runtime performance observation

Implemented: [get_performance_monitors](../src/runtime-tools.ts) returns bounded snapshots with timestamps, units and unavailable headless renderer metrics. Paused-session `sample_performance` and `sample_node_properties` provide frame-based series and minimum, maximum, mean and percentile summaries. Custom monitors and passive capture remain planned.

Call this monitor sampling, not a full profiler: function-level CPU attribution and detailed GPU profiling require additional instrumentation. Establish useful observation before inventing optimization tools.

### 4. Offer an optional editor bridge, then debugger integration

An editor addon could expose selection, unsaved changes and UndoRedo-backed mutations for users working interactively in Godot. Keep our addon-free workflow as the default and advertise editor-dependent capabilities only when connected.

True debugging is a separate investment. Our SceneTree pause and frame stepping do not stop at a GDScript statement or expose stack-local variables. Breakpoints, stack inspection and execution stepping need their own protocol and lifecycle, including handling a stopped interpreter that cannot service normal runtime requests.

## Smaller improvements alongside feature work

Implemented: new tools declare output schemas, playtest operational failures have stable codes, and tool specifications carry destructive-operation annotations rather than marking every non-read operation destructive. Inspector schema portability is clean. Remaining: central validation errors are still text-oriented and legacy tools lack complete output schemas. Migrate these incrementally. [Server error handling](../src/index.ts), [registry](../src/tool-registry.ts)

Dependency impact analysis is a sensible extension of project overview, with explicit incomplete results for dynamic paths and binary resources. Domain-specific authoring should follow the shared resource foundation and actual user demand. The best next release would improve reliable scene construction and repeatable verification, rather than reproduce every specialized category.
