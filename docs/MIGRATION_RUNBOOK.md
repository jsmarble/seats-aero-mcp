# Runbook: Migrate an MCP repo to Joshua's Cloudflare-hosted MCP platform

**Audience:** an autonomous AI agent performing the full migration and deployment in one shot, without human intervention except where explicitly marked **HUMAN GATE**.

**Goal:** take an existing MCP server repo on GitHub (usually stdio-based) and turn it into a public, bring-your-own-key, stateless Cloudflare Worker served at `https://mcp.joshuamarble.io/<server-name>`, with quality gates and auto-deploy via GitHub Actions.

**Reference implementation:** this repo ([jsmarble/seats-aero-mcp](https://github.com/jsmarble/seats-aero-mcp)). When in doubt, copy its structure verbatim and adapt names. It was migrated from [cjmcenery/seats-aero-mcp](https://github.com/cjmcenery/seats-aero-mcp), a single-file stdio server using `node-fetch` — the "before" and "after" of this runbook.

---

## 0. Fixed platform facts (do not rediscover these)

| Fact | Value |
|------|-------|
| Shared MCP hostname | `mcp.joshuamarble.io` (zone `joshuamarble.io`) |
| Cloudflare account | "Tolvit LLC", account ID `0df8761d9c37596bc3b04c09edd279a8` |
| Hostname owner | The `seats-aero-mcp` Worker holds the hostname as a **Custom Domain**. **New servers must NOT use `custom_domain`** — claim a route pattern instead (§4). DNS and cert already exist. |
| URL scheme | MCP endpoint at `https://mcp.joshuamarble.io/<name>` (the path IS the endpoint), health at `/<name>/health` |
| Joshua's GitHub | `jsmarble`. The gh CLI has multiple accounts and `gh auth switch` does **not** reliably persist across shell invocations — always `gh auth switch --user jsmarble && <command>` in one invocation. |
| Hard constraints | Cloudflare **Durable Objects are banned**. Use `createMcpHandler()` from the `agents` SDK. Public bring-your-own-key: no provider credentials stored server-side. |
| Login shell | fish — multi-statement shell logic breaks; wrap anything nontrivial in `bash -c '...'`. |

---

## 1. Prerequisites check (fail fast)

```bash
gh auth switch --user jsmarble && gh api user --jq .login   # must print jsmarble
npx wrangler whoami                                          # must show Tolvit LLC
```

- If wrangler is not logged in: run `npx wrangler login` as a **background** task, extract the OAuth URL from its output, present it to Joshua, and wait for the callback to complete. **HUMAN GATE** (browser approval).
- Pick the server's path segment `<name>` (kebab-case, e.g. `linear`, `weather`). Check it's unclaimed: `curl -s https://mcp.joshuamarble.io/<name>/health` should NOT return a healthy JSON from another server, and the root index `curl -s https://mcp.joshuamarble.io/` lists what exists.

## 2. Fork and clone

```bash
gh auth switch --user jsmarble && gh repo fork <upstream-owner>/<repo> --clone --fork-name <name>-mcp
cd <name>-mcp   # origin = jsmarble fork, upstream = original (gh sets both)
```

If Joshua already has a fork with diverged commits, keep history without force-pushing: commit your work on the local base, then `git merge -s ours origin/main` so the pushed tree is exactly yours (see seats-aero-mcp commit `8b5de39` for precedent).

## 3. Study the upstream API before writing code

Do not trust the original repo's tool schemas — verify against the provider's actual API docs (fetch their OpenAPI spec / llms.txt if available). For each tool capture: exact endpoint path + method, exact parameter names, required vs optional, enums, defaults, pagination scheme, auth header name, and rate-limit semantics. The original repo may have wrong parameter names or missing endpoints; probing an endpoint unauthenticated (expect 401 vs 404) confirms whether it exists.

## 4. Target architecture (copy from the reference repo)

Source layout — split, not single-file:

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Worker entry. Path routing (BASE_PATH + legacy `/mcp`), per-request API-key resolution, 401 JSON-RPC error when keyless, optional Access check, then `createMcpHandler(server, { route: url.pathname })(request, env, ctx)` |
| `src/server.ts` | `buildServer(apiKey)` returning a **fresh `McpServer` per request** (the SDK forbids reconnecting a connected server; a module-level singleton will throw). Tools via `server.registerTool(name, { title, description, annotations, inputSchema }, handler)` — not the deprecated `server.tool()` |
| `src/<provider>-client.ts` | Fetch-based API client: native `fetch` (never `node-fetch`), `AbortSignal.timeout(...)`, distinct error messages for 401/403 (bad key) and 429 (include `Retry-After`) |
| `src/access.ts` | Optional Cloudflare Access JWT validation via `jose` (copy verbatim; inert unless `ACCESS_TEAM_DOMAIN` + `ACCESS_APP_AUD` are set) |
| `src/env.d.ts` | Interface-merge declarations for secrets/optional vars ONLY. Do **not** redeclare vars that are in `wrangler.jsonc` `vars` — `wrangler types` generates literal types for those and conflicting redeclaration breaks the build |

Behavioral rules (these are the product decisions; keep them):

- **BYOK headers**, in precedence order: `X-<Provider>-Api-Key` (invent the obvious name), the provider's own auth header name, `Authorization: Bearer <key>`; optional server-side fallback secret for private deployments. Key is forwarded per-request, never logged or stored.
- Keyless request to the MCP endpoint → HTTP 401 with a JSON-RPC error explaining exactly which header to send.
- Tool handler failures return `{ content: [{type:"text", text: <message>}], isError: true }` — never throw through the protocol.
- Responses are compact `JSON.stringify(data)` (no pretty-printing — wastes tokens).
- If the API's default page size is large, cap the default (seats.aero: 500 → 50) and document it in the tool description; expose the real limits via zod (`.int().min().max()`).
- zod v4 schemas with real enums, date-format regexes, and range constraints; every tool gets `annotations: { readOnlyHint: true, openWorldHint: true }` (adjust honestly if a tool mutates state).
- Tool descriptions teach the model the workflow: pagination fields, ID-chaining between tools, tier restrictions, retry guidance.

`wrangler.jsonc` for a new server (**route pattern, NOT custom_domain**):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "<name>-mcp",
  "main": "src/index.ts",
  "compatibility_date": "<recent>",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "workers_dev": true, // adding routes silently disables workers.dev; keep it as fallback
  "routes": [
    { "pattern": "mcp.joshuamarble.io/<name>*", "zone_name": "joshuamarble.io" }
  ],
  "vars": { "BASE_PATH": "/<name>" }
}
```

`package.json` essentials: `"type": "module"`, `"private": true`, `"engines": {"node": ">=22"}` (CI reads it via `node-version-file: package.json`). Dependencies: `agents`, `@modelcontextprotocol/sdk` (≥1.29), `zod` (v4), `jose`. DevDependencies: `wrangler`, `typescript`, `@types/node`, `@biomejs/biome`, `vitest` (v4), `@cloudflare/vitest-pool-workers`, `msw`. Scripts: copy from the reference repo (`dev`, `deploy`, `types`, `check` = tsc over src **and** test, `lint`, `test`).

Delete from the upstream repo: stdio transport, `node-fetch`, `bin` entry, committed `dist/`, `.env.example` (replace with `.dev.vars.example`). `.gitignore` adds: `.dev.vars`, `.wrangler/`, `worker-configuration.d.ts`, `dist/`.

- If npm blocks install scripts: `npm approve-scripts workerd` (and whatever else it lists) or `wrangler dev`/tests won't run.
- `npm run types` (i.e. `wrangler types`) generates `worker-configuration.d.ts`; it's gitignored, so CI must regenerate it before typechecking (the reference ci.yml does).

## 5. Quality tooling

- **Biome**: copy `biome.json` from the reference repo. Run `npx biome check --write .` once to normalize, and `npx biome migrate --write` if it complains about schema drift.
- **Tests** (`@cloudflare/vitest-pool-workers` ≥0.18 — API changed; the old docs are wrong):
  - `vitest.config.ts` uses the `cloudflareTest` **plugin** from `"@cloudflare/vitest-pool-workers"` — NOT `defineWorkersConfig` from `"./config"` (removed).
  - Outbound mocking is **msw** (`setupServer` from `msw/node` + `test/setup.ts` with `onUnhandledRequest: "error"`) — the old `fetchMock` from `cloudflare:test` is gone. `onUnhandledRequest: "error"` doubles as network isolation: any unmocked outbound call fails the suite.
  - `test/tsconfig.json` needs `"types": ["../worker-configuration.d.ts", "@cloudflare/vitest-pool-workers/types"]` (note the `/types` subpath).
  - Miniflare loads `wrangler.jsonc`, so `BASE_PATH` is live in tests.
  - MCP responses arrive as SSE — parse the `data: ` line (copy `readRpcResult` from `test/worker.spec.ts`).
  - Minimum test matrix (adapt from the reference's 16 tests): health, 404, root index, keyless→401, bearer-header accepted, initialize handshake, tools/list names, zod rejection of bad args, **key-forwarding assertion** (msw resolver captures the auth header), default-page-size assertion, POST-body assertion for any POST tool, upstream 401→isError, upstream 429→isError with Retry-After, BASE_PATH endpoint + legacy `/mcp` coexistence.

All four gates must pass locally before deploying: `npm run lint && npm run check && npm test && npx wrangler deploy --dry-run --outdir dist`.

## 6. CI/CD

Copy `.github/workflows/ci.yml` and `.github/dependabot.yml` from the reference repo, then adapt: the environment `url` and the smoke-test `MCP`/`FALLBACK` URLs. Structure to preserve:

- Triggers: `push` (main), `pull_request`, `workflow_dispatch`.
- `quality` job: npm ci → biome → `npm run types` → typecheck → tests → wrangler dry-run → a step that exports `can-deploy` from whether `secrets.CLOUDFLARE_API_TOKEN` is non-empty (secrets are not readable in job-level `if`; the step-output dance is required).
- `deploy` job: `needs: quality`, main-only, `environment: production` with the live URL, `concurrency: { group: deploy-production, cancel-in-progress: false }`, `cloudflare/wrangler-action`, then a post-deploy smoke test (health on custom domain + workers.dev, keyless 401, tools/list with a dummy key).
- Pin all actions to commit SHAs with `# vX.Y.Z` comments (resolve current SHAs via `gh api repos/<action>/git/ref/tags/<tag>`); `permissions: contents: read`; validate with `actionlint` before pushing.

Secrets on the new repo:

```bash
gh auth switch --user jsmarble && gh secret set CLOUDFLARE_ACCOUNT_ID --repo jsmarble/<name>-mcp --body 0df8761d9c37596bc3b04c09edd279a8
gh secret list --repo jsmarble/<name>-mcp
```

- `CLOUDFLARE_API_TOKEN`: **HUMAN GATE**. You must never accept, paste, or set the token value yourself — if Joshua pastes a token into chat, tell him it's exposed and must be rotated. Ask him to run `gh secret set CLOUDFLARE_API_TOKEN --repo jsmarble/<name>-mcp` (interactive paste). His existing token is the "Edit Cloudflare Workers" template and is known to handle route + custom-domain deploys. Until the secret exists the deploy job skips cleanly and CI stays green — safe to push before the gate clears.

## 7. Deploy and verify

1. Local first (uses wrangler OAuth): `npm run deploy`. Expect output listing both the workers.dev URL and the `mcp.joshuamarble.io/<name>*` route.
2. Live verification (all through `bash -c`):
   - `curl https://mcp.joshuamarble.io/<name>/health` → `{"status":"ok",...}` (first hit after deploy can transiently return a Cloudflare 1104/52x — retry a few times before diagnosing).
   - Keyless POST to `https://mcp.joshuamarble.io/<name>` → 401 with the header instructions.
   - `tools/list` with a dummy key header → full tool set.
   - A real `tools/call` with a dummy key → `isError` result whose text shows the **provider's** auth rejection (proves the header key is forwarded end-to-end).
   - workers.dev fallback `/health` → 200.
3. Push everything; watch the run to completion: `gh run watch <id> --repo jsmarble/<name>-mcp --exit-status`. The deploy job re-deploying green in CI is the proof the pipeline owns the worker from now on.
4. Update the GitHub repo description: `gh repo edit jsmarble/<name>-mcp --description "..."`.

## 8. README requirements

Rewrite (don't append). Must contain, in order: what it is + BYOK statement (no credentials stored, no login, 401 if keyless) + provider-subscription requirement; a header table (all accepted key headers); copy-pasteable connect configs with the **real** URL for Claude Code (`claude mcp add --transport http ... --header ...`) and Claude Desktop via `mcp-remote`; MCP Inspector instructions; tool table mapping tool → provider endpoint; self-hosting (local dev with `.dev.vars`, deploy, config reference table); the shared-hostname explanation (route pattern joining `mcp.joshuamarble.io`); CI/CD section with badge and the two secrets; privacy note; the upstream credit; the original license and any liability disclaimer from upstream (preserve it).

## 9. Known pitfalls (each of these cost real time — don't repeat them)

1. **fish shell** eats `for` loops, `===`, and heredoc-ish one-liners → `bash -c`.
2. `gh auth switch` reverts between invocations → switch-and-act in one command.
3. `wrangler dev` does **not** reliably hot-reload `.dev.vars` → kill and restart the dev server after changing it.
4. Adding `routes` to wrangler.jsonc **silently disables workers.dev** → set `"workers_dev": true` explicitly.
5. `@cloudflare/vitest-pool-workers` 0.18 broke the documented API twice: config helper moved (plugin `cloudflareTest`), and `fetchMock` was replaced by msw. Check the fixtures in `cloudflare/workers-sdk` `fixtures/vitest-pool-workers-examples/` rather than the docs when versions bump again.
6. `npm ci`-time postinstall for `workerd` must be allowed (`allowScripts` in package.json persists this).
7. Don't redeclare wrangler-`vars` in `env.d.ts` (literal-type merge conflict); declare only secrets/undeclared optionals there.
8. Interpolating `${{ secrets.X }}` in a job-level `if` doesn't work — export a step output from the quality job.
9. The upstream repo's docs index may omit live endpoints — probe with unauthenticated requests (401 = exists, 404 = doesn't).
10. First deploy of a new route: only paths matching `mcp.joshuamarble.io/<name>*` reach the new worker; anything else on the hostname falls through to the custom-domain worker (seats-aero-mcp), whose root `/` serves the index. Consider asking Joshua whether the index should list the new server (it currently only self-describes).

## 10. One-shot order of operations

```text
prereq checks → fork+clone → study upstream API → rewrite src/ (4 files) →
wrangler.jsonc (route+BASE_PATH) → package.json/tsconfig/.dev.vars.example/.gitignore →
npm install (+approve-scripts) → npm run types → biome + tests green locally →
wrangler dev smoke test (health, 401, tools/list, dummy-key forwarding) →
copy+adapt ci.yml/dependabot → actionlint → set CLOUDFLARE_ACCOUNT_ID secret →
local deploy → live verification on mcp.joshuamarble.io/<name> →
README rewrite → commit+push → watch CI green →
HUMAN GATE: ask Joshua for CLOUDFLARE_API_TOKEN secret → rerun/dispatch → confirm CI deploy+smoke green →
gh repo edit description → report URLs and any deviations
```
