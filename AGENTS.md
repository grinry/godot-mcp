# Project instructions

## Working with the user

- Do not use `autoResolutionMs`. If user input is required, wait for the user to answer; do not choose a default after a timeout.
- Preserve unrelated working-tree and staged changes.

## Project overview

This repository is `grinry/godot-mcp`. The public npm package is `@grinry/godot-mcp`; its executable is `godot-mcp`. Keep original author credit in README.md and package.json, and preserve the MIT license.

The server uses MCP over stdio to launch Godot, run projects, collect debug output, and manipulate scenes and resources. Simple operations call the Godot executable directly; complex operations use a bundled GDScript script.

## Source map

- `src/index.ts`: MCP server, argument normalization, Godot detection, and session/process orchestration.
- `src/tool-registry.ts`: tool registration, discovery, dispatch, annotations, and session metadata.
- `src/legacy-tools.ts` / `src/legacy-handlers.ts`: legacy tool schemas and handlers.
- `src/scene-tools.ts`, `src/runtime-tools.ts`, `src/project-overview.ts`: scene transactions, live inspection/stepping, and project discovery.
- `src/scripts/godot_operations.gd`: Godot-side scene and resource operations.
- `scripts/build.js`: makes the compiled entry point executable and copies the GDScript into `build/scripts/`.
- `README.md`: installation, client configuration, features, and troubleshooting.
- `CONTRIBUTING.md`: development conventions and release setup.
- `.changeset/`: release notes and Changesets configuration.
- `.github/workflows/release.yml`: version PRs and public npm publishing through trusted publishing (OIDC).

`build/` is generated and ignored. Edit source files, not generated output.

## Working aggreements

- Never commit and push without approval.
- `main` is primary branch, start feature branches from it when starting working on a new feature. PR's need to target it too.

## Development commands

Use npm and keep `package-lock.json` synchronized with dependency changes.

- `npm ci`: install locked dependencies; the `prepare` lifecycle also builds the project.
- `npm run build`: compile TypeScript, make the entry point executable, and copy the GDScript.
- `npm run check`: check Biome formatting, lint, and import sorting; warnings fail the check.
- `npm run check:fix`: apply formatting, safe lint fixes, and import sorting.
- `npm run format`: format supported files.
- `npm run lint`: run lint rules only.
- `npm test`: build and run regression tests.
- `npm run build:mcpb`: create and verify the desktop bundle in ignored `dist/`.
- `npm run watch`: watch and compile TypeScript only; run a full build after GDScript changes.
- `npm run inspector`: open the MCP Inspector against the built server.
- `npm pack --dry-run`: inspect package contents without publishing.

The package declares Node.js >=22.14; the release workflow uses Node.js 24. Keep runtime changes compatible with the declared minimum unless intentionally updating it.

## Implementation conventions

- Follow the existing TypeScript style: strict checking, ESM imports, two-space indentation, and single quotes. Use `.js` extensions for relative imports in emitted ESM where required.
- Reserve server stdout for MCP protocol messages. Send diagnostics to stderr using `console.error` or `console.warn`.
- Preserve `GODOT_PATH` overrides and `DEBUG=true` logging behavior.
- Keep tool schemas, dispatch, handlers, parameter mappings, and GDScript operations consistent. Preserve existing snake_case/camelCase argument compatibility.
- Validate user-supplied paths and arguments before invoking Godot. Prefer argument arrays with `spawn`/`execFile` to shell-interpolated commands.
- Preserve cross-platform path handling and Godot executable discovery for macOS, Windows, and Linux.
- Handle child-process errors and cleanup explicitly; avoid leaving Godot processes running after completion or shutdown.
- When adding or changing a tool, update the README features/configuration examples and relevant contribution documentation.

## Verification

Run `npm test` for lifecycle and discovery regression coverage. Set `GODOT_TEST_PATH` to include real Godot integration tests `GODOT_TEST_RENDER=true` for display-dependent screenshots, `GODOT_TEST_EXPORT=true` for a Web export with installed templates, and `GUT_TEST_ADDON_PATH` for installed GUT integration. Biome and regression tests run in CI.

- Run `npm run check` after changes to supported source/configuration files.
- Biome uses recommended rules with two exceptions scoped to the legacy `src/index.ts` and moved `src/legacy-handlers.ts`: explicit `any` and non-null assertions. Avoid introducing these patterns in new code.
- Biome does not format GDScript, Markdown, or YAML; review those files separately.

- Run `npm run build` after TypeScript, GDScript, dependency, or build changes.
- For tool behavior changes, exercise affected tools with the MCP Inspector and a disposable Godot project when Godot is available. Check success and invalid-input behavior. Report when runtime verification is unavailable.
- For packaging changes, inspect `npm pack --dry-run`: it must include `build/index.js`, `build/scripts/godot_operations.gd`, README, and LICENSE, with the executable registered correctly.
- Validate workflow/configuration syntax when changing release automation.
- Documentation-only changes generally need a diff review, not a full build.

## Releases

- Keep changeset summaries short: one or two sentences describing user-facing changes. Omit implementation details, test lists, and issue/PR inventories.
- Add a changeset with `npm run changeset` for releasable changes, selecting `@grinry/godot-mcp` and the appropriate version bump. Documentation-only  changes (or changes that does not touch ./src or ./scripts) need no changeset unless intended for publication.
- Let Changesets manage versions and changelogs. `npm run version-packages` consumes changesets and synchronizes the lockfile; do not run it during routine implementation unless preparing a release.
- Pushes to `main` create/update a release PR when changesets are pending. Merging that PR publishes the new version publicly and creates a GitHub release.
- CI uses npm trusted publishing configured for `grinry/godot-mcp` and workflow `release.yml`, with `id-token: write`. Do not introduce npm tokens or committed credentials.
- `npm run release` builds and publishes to npm. Run publishing commands only when the user requests a release.
