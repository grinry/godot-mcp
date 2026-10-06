# Comparison with hybridindie/godot-mcp

Research date: 2026-10-06. Last updated: 2026-10-06. This living document tracks implementation in this checkout, not published package availability. The competitor comparison is based on documentation and source, not an end-to-end verification of its tools.

## Implementation tracker

| Area | Our status | Remaining difference / next work |
| --- | --- | --- |
| Saved scene transactions | Implemented before this comparison | Inherited scenes and editing instance contents remain unsupported. |
| Scene instancing and duplication | Implemented and verified | `instance_scene` / `duplicate_node` also work inside `modify_scene`. Duplication refuses instances, unique-name nodes, external node links and uncertain embedded references. Subtree extraction remains planned. |
| Generic resource inspection/creation/editing | Implemented and verified | `get_resource_info`, `create_resource`, `set_resource_properties` cover built-in `.tres`/`.res` resources and supported typed properties. Custom resource creation, collections, transforms and specialized resource graphs remain planned. |
| Reusable gameplay scenarios | Implemented; headless and rendered checks passed | `run_playtest` queues inputs at stepped frame boundaries, asserts state and returns screenshots/diagnostics, then stops the game. Screenshot baseline comparison, input recording and stress testing remain planned. |
| Performance monitoring and property sampling | Snapshot and sampling implemented; targeted checks passed | `get_performance_monitors`, `sample_performance` and `sample_node_properties` provide bounded evidence and summaries. Custom monitors, passive capture and full profiling remain missing. |
| Settings / autoload / InputMap editing | Implemented; targeted checks passed | Eight tools preserve comments, unrelated entries and autoload order with previews/hash checks. Autoload validation covers names/paths, not script inheritance, compilation, global-class conflicts or .NET compatibility. Unsupported input event variants remain read-only. |
| Live editor / native undo | Missing, optional extension planned | Selection, unsaved scenes and editor UndoRedo need an editor bridge. |
| Breakpoint debugger | Missing | SceneTree pause/frame stepping exist; script breakpoints, call stacks and local variables do not. |
| Specialized authoring and analysis | Partial | Basic node/property authoring and dependency overview exist; animation, TileSet, audio bus, shader graph tools and impact analysis remain missing. |
| API contracts | Improved and verified | New tools declare output schemas; playtest runtime errors have stable codes. Tool specifications identify destructive operations, distinguishing them from ordinary execution/mutation. Legacy output schemas/errors remain incomplete. |

Statuses become implemented only after code and relevant checks are complete. Verification results and limitations are recorded below as work progresses.

### Verification log

- 2026-10-06, first batch on `feat/authoring-playtest-foundation`: TypeScript build and targeted real-Godot 4.7.1 tests passed. Scene duplication preserved scripts, ownership, groups, internal NodePaths/exported Node references and persistent signals after reload. Scene instancing preserved the source-scene link and refused recursion. Resource tests covered text/binary files, external material references, dry runs, stale hashes, invalid properties, symlink confinement and concurrent create/write refusal.
- Gameplay tests passed with action/key input, exact physics-frame counters, approximate vector assertions, assertion failures, missing properties, process cleanup and an inline rendered screenshot. A first test exposed buffered input arriving one frame late; queued events now flush at the resume boundary. Portable tests cover cancellation/deadlines and reject truncated assertion values. Performance snapshot tests cover timestamps, units, paused state and headless unavailable metrics.
- Full real-engine regression: **38 passed, none skipped** with Godot 4.7.1, rendering, Web export templates and GUT, on Node 24 and the declared minimum Node 22.14. Final Node 24 run passed all 38 after annotation/incomplete-log fixes; the affected portable tests additionally passed on Node 22.14. Modern-client checks include playtest session handles, retained final logs and handle closure. Resource tests also verify unchanged UIDs and refusal of unique-name duplication.
- MCP Inspector 2.9.0: strict discovery has **zero schema errors/warnings**, and 13 CLI calls verified success/invalid-input cases for scene/resource/playtest tools and missing-session rejection for monitors. Successful paused monitor reads are covered by the live MCP regression. Desktop bundle validation confirms **46 tools** with matching discovery/manifest metadata. Build, Biome and `npm pack --dry-run` passed; package contents include the executable, engine scripts, README and MIT license. A minor changeset records the additions; versions were not changed.
- 2026-10-06, second batch: **43 passed, none skipped** on both Node 24 and Node 22.14 with real Godot 4.7.1, rendered screenshots, Web export and GUT. Configuration tests cover comment/CRLF preservation, shared write serialization, dry runs/stale hashes, autoload order and isolation, supported binding round trips and fresh-launch application. Sampling covers exact resumed physics callbacks, scalar/vector summaries, bounded evidence, pause retention, invalid inputs, deadlines and independent modern-client session handles.
- MCP Inspector 2.9.0 verified 13 configuration/sampling calls (success and invalid-input/missing-session cases), plus strict discovery with zero schema warnings/errors. Inspector exposed an all-actions nullable-key output mismatch, corrected and rechecked. Successful sampling is exercised through live MCP regressions. Desktop bundle validates **56 tools**; build, Biome, diff checks and package contents passed. A second minor changeset records this batch.
- These entries describe working-tree implementation, not a release. Positive .NET support and native Windows/Linux engine behavior have not been verified in this batch.

### Next implementation batches

1. Subtree extraction with explicit multi-file failure/rollback semantics, then broader resource value types.
2. Richer resource/configuration value types, input event variants and deeper autoload compatibility validation.
3. Screenshot baseline comparison, recorded input sequences and custom/passive monitor capture.
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
- Project overview reads settings, autoloads, input actions and text-resource dependencies; reflection exposes installed-engine class metadata. `set_main_scene` already changes one project setting. The missing pieces are broader editing and analysis, rather than basic discovery. [Project overview](../src/project-overview.ts), [authoring tools](../src/authoring-tools.ts)

## Recommended priorities

### 1. Finish the scene and resource authoring foundation

Implemented: scene instancing, conservative subtree duplication and generic built-in resource creation/inspection/editing. Agents can assemble reusable scenes and configure supported materials/shapes through Godot. See [scene tools](../src/scene-tools.ts) and [resource tools](../src/resource-tools.ts).

Reuse our typed values, path confinement, previews and content-hash checks. Keep ownership and instance boundaries explicit. Extraction writes multiple files, so its failure and rollback contract needs particular care. Follow with settings, autoload and InputMap editors that preserve unrelated configuration. This would expand everyday construction workflows substantially while fitting our current architecture.

### 2. Add reusable playtest scenarios

Implemented as [run_playtest](../src/playtest-tools.ts): start a scene, queue input, advance frames, assert property values with tolerances, capture evidence and return a structured pass/fail report. The owned game stops after success, failure or cancellation, releasing held inputs and temporary IPC. Reports refuse to claim success when game logs truncate.

Start with state assertions and input sequences. Add screenshot baselines later with configurable masks and thresholds; rendering differences must not become unexplained failures. A recorded input sequence is useful automation, but should not be described as deterministic replay. Reuse GUT for tests requiring project-specific logic.

### 3. Add runtime performance observation

Implemented: [get_performance_monitors](../src/runtime-tools.ts) returns bounded snapshots with timestamps, units and unavailable headless renderer metrics. Next: sampled node properties and monitor series with minimum, maximum and percentile summaries. This would help distinguish frame-time regressions, object growth and gameplay-state drift from a single snapshot.

Call this monitor sampling, not a full profiler: function-level CPU attribution and detailed GPU profiling require additional instrumentation. Establish useful observation before inventing optimization tools.

### 4. Offer an optional editor bridge, then debugger integration

An editor addon could expose selection, unsaved changes and UndoRedo-backed mutations for users working interactively in Godot. Keep our addon-free workflow as the default and advertise editor-dependent capabilities only when connected.

True debugging is a separate investment. Our SceneTree pause and frame stepping do not stop at a GDScript statement or expose stack-local variables. Breakpoints, stack inspection and execution stepping need their own protocol and lifecycle, including handling a stopped interpreter that cannot service normal runtime requests.

## Smaller improvements alongside feature work

Implemented: new tools declare output schemas, playtest operational failures have stable codes, and tool specifications carry destructive-operation annotations rather than marking every non-read operation destructive. Inspector schema portability is clean. Remaining: central validation errors are still text-oriented and legacy tools lack complete output schemas. Migrate these incrementally. [Server error handling](../src/index.ts), [registry](../src/tool-registry.ts)

Dependency impact analysis is a sensible extension of project overview, with explicit incomplete results for dynamic paths and binary resources. Domain-specific authoring should follow the shared resource foundation and actual user demand. The best next release would improve reliable scene construction and repeatable verification, rather than reproduce every specialized category.
