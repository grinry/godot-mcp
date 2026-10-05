# MCP 2026-07-28 migration research

Checked 2026-10-05. This is the pre-implementation research snapshot. The migration is now implemented; see [upstream issue validation](upstream-issue-review.md) and `tests/protocol.test.mjs` for verification and remaining limits.

## Recommendation

A production SDK migration **is available**. The official repository identifies its split v2 packages as the stable implementation of MCP 2026-07-28. Public npm registry queries returned `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/client@2.3.1`, and legacy `@modelcontextprotocol/sdk@1.32.1`. Server 2.3.1 requires Node >=20, compatible with our >=22.14 minimum. These registry observations can be repeated with `npm view PACKAGE version dist-tags engines --json`. [Official SDK repository](https://github.com/modelcontextprotocol/typescript-sdk), [published server package](https://www.npmjs.com/package/@modelcontextprotocol/server).

The installed legacy SDK 1.32.1 still declares `LATEST_PROTOCOL_VERSION = '2025-11-25'` in `node_modules/@modelcontextprotocol/sdk/dist/esm/types.js`. Updating only the `^1.30.1` range cannot resolve upstream #135. Upgrade through official v2 and opt into its modern serving entry; do not create an ad hoc `server/discover` adapter or claim modern compliance from negotiation alone.

## Concrete stdio route

The official migration guide supports retaining the low-level `Server` implementation and existing tool tables. Move server/types imports to `@modelcontextprotocol/server`, public Zod wire-schema imports where needed to `@modelcontextprotocol/core`, and test clients to `@modelcontextprotocol/client` plus `/stdio`. Handler registration changes from schema-first to method strings; cancellation moves from `extra.signal` to `ctx.mcpReq.signal`. Errors move to v2 protocol/SDK error classes and enums. Annotate tool/result tables to satisfy JSON-value types instead of widening object literals or accepting `undefined` properties. [Official v1-to-v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2).

For modern stdio, use `serveStdio(() => buildServer())` from `@modelcontextprotocol/server/stdio`. Its connection opening chooses an era and pins one factory instance. Directly connecting a `Server` to `StdioServerTransport`, even on v2, still serves only the older era. Preserve the default legacy-compatible entry so existing clients continue to initialize normally; tests can opt into modern `ClientOptions.versionNegotiation` using auto or a pinned 2026 revision. [Official modern protocol migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html#server-over-stdio-long-lived-connections-servestdio).

SDK v2's modern codec handles response discrimination, server identity metadata and per-request protocol envelopes. Cacheable responses default to zero TTL/private scope unless configured through `ServerOptions.cacheHints`. The application should continue returning neutral tool results; adding modern wire fields directly to every handler risks leaking incompatible fields to older clients. [Protocol migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html), [official wire schema](https://modelcontextprotocol.io/specification/2026-07-28/schema).

## Stateful Godot operations need application changes

The new specification requires request metadata to establish context and explicit identifiers for state spanning requests. Our current singleton game/editor/live slots implicitly select a process from prior calls. Protocol-correct modern tools should return opaque process/debug-session identifiers from launch operations and require the appropriate identifier for subsequent logs, input, pause, captures and stop. Legacy clients can retain their existing per-connection behavior through an intentional compatibility branch. Do not trust client identity metadata as authentication. The SDK migration fixes protocol framing; it does not invent these application handles. [Official base protocol statelessness requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic#statelessness).

This is implementation work, not an unavailable-SDK blocker. A small handwritten adapter is technically possible but unjustified: it would need correct version routing, schemas, result/cache/identity fields, cancellation and legacy framing that the stable official SDK already implements.

## Acceptance evidence required before claiming #135 resolved

- Raw modern stdio requests: `server/discover` before initialize; correct declared versions/capabilities/server identity and conservative cache fields.
- Modern `tools/list` and `tools/call` with request envelopes; raw replies include required result fields, while older-era replies retain their correct older format.
- Official modern pinned client and legacy client can independently enumerate and invoke tools; unknown methods and malformed envelopes produce defined errors without killing the server.
- Cancellation terminates Godot work; transport close/shutdown cleans managed children.
- Modern process/session handles prevent unrelated callers from accidentally selecting each other's game/editor/live state.
- Full repository checks, real Godot integrations where available, packaging and MCPB parity after replacing dependency imports.

Keep published compatibility claims limited to tested protocol versions. The upstream automated sweep is a useful secondary signal, but the official schema and raw official-client interoperation control acceptance.
