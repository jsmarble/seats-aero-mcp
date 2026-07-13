# seats-aero-mcp

[![CI / Deploy](https://github.com/jsmarble/seats-aero-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jsmarble/seats-aero-mcp/actions/workflows/ci.yml)

A public, remote [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for the [seats.aero](https://seats.aero) Partner API, running on [Cloudflare Workers](https://developers.cloudflare.com/workers/). It lets AI assistants like Claude search award flight availability — cached search, bulk availability, routes, flight-level trip details, and live search.

Anyone can connect. **You bring your own seats.aero API key**: the server stores no credentials, requires no login, and simply forwards your key to seats.aero on each request.

> **You need a seats.aero Pro subscription** to get a Partner API key (see the [Partner API docs](https://developers.seats.aero/reference/getting-started-p)). Your usage is metered and rate-limited by seats.aero against your own key.

Built on the stateless [`createMcpHandler()`](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/) pattern from the Cloudflare Agents SDK — Streamable HTTP transport at `/mcp`, no Durable Objects, no per-session state.

## Using the server

You need two things:

1. **The server URL** — `https://mcp.joshuamarble.io/seats-aero` (or `https://seats-aero-mcp.tolvit-llc.workers.dev/mcp` as a fallback; see [Self-hosting](#self-hosting) to deploy your own)
2. **Your seats.aero Partner API key** — sent as an HTTP header on every request

Your MCP client must support custom headers on remote servers. Any of these headers works:

| Header | Format | Notes |
|--------|--------|-------|
| `X-Seats-Aero-Api-Key` | `<key>` | Preferred |
| `Partner-Authorization` | `<key>` | Same header seats.aero's own API uses |
| `Authorization` | `Bearer <key>` | For clients that only support bearer auth |

Requests without a key get a `401` with instructions. The key is used for the one request and never logged or stored.

### Claude Code

```bash
claude mcp add --transport http seats-aero https://mcp.joshuamarble.io/seats-aero \
  --header "X-Seats-Aero-Api-Key: YOUR_SEATS_AERO_KEY"
```

### Claude Desktop (and other clients without native remote MCP support)

Via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "seats-aero": {
      "command": "npx",
      "args": [
        "mcp-remote", "https://mcp.joshuamarble.io/seats-aero",
        "--header", "X-Seats-Aero-Api-Key: YOUR_SEATS_AERO_KEY"
      ]
    }
  }
}
```

### MCP Inspector (testing)

```bash
npx @modelcontextprotocol/inspector@latest
# Transport: Streamable HTTP → https://mcp.joshuamarble.io/seats-aero
# Add header: X-Seats-Aero-Api-Key: YOUR_SEATS_AERO_KEY
```

A quick liveness check needs no key: `curl https://mcp.joshuamarble.io/seats-aero/health`

### Things to ask once connected

- *"Find business class award availability from SFO to Tokyo in June"*
- *"Search for United miles availability from LAX to London next month, cheapest first"*
- *"What routes does Aeroplan track from North America to Europe?"*
- *"Show me the flight segments for that first availability result"*

## Tools

| Tool | seats.aero endpoint | Description |
|------|---------------------|-------------|
| `search_availability` | `GET /search` | Search cached award availability between specific airports across all cabins and mileage programs |
| `bulk_availability` | `GET /availability` | All cached availability for one mileage program, filterable by cabin, dates, and region |
| `get_trips` | `GET /trips/{id}` | Flight-level segments, times, mileage cost, and taxes for an availability result |
| `get_routes` | `GET /routes` | All routes seats.aero tracks for a mileage program |
| `live_search` | `POST /live` | Real-time search against the mileage program itself (**not available on Pro keys** — requires a commercial seats.aero agreement) |

All tools are read-only. Paginated tools default to 50 results per page (the API default of 500 is usually too large for an LLM context window); the model can pass `take` (10–1000), `cursor`, and `skip` to page through more, deduplicating by `ID`.

## Self-hosting

### Local development

```bash
npm install
npm run dev   # wrangler dev → http://localhost:8787/mcp
```

Point the MCP Inspector at `http://localhost:8787/mcp` with your key header. To skip sending the header while testing, copy `.dev.vars.example` to `.dev.vars` and set `SEATS_AERO_API_KEY` as a local fallback key.

### Deploy

```bash
npm run deploy
```

That's it — no secrets or bindings are required for a public deployment. The endpoint is `https://<worker>.<your-subdomain>.workers.dev/mcp`, or put the Worker behind a [custom domain or route](https://developers.cloudflare.com/workers/configuration/routing/).

This deployment uses a shared MCP hostname: the Worker holds `mcp.joshuamarble.io` as a [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) (DNS and certificate are auto-managed by Cloudflare) and serves its endpoint at the `BASE_PATH` var (`/seats-aero`), with the legacy `/mcp` path still answered on workers.dev. Additional MCP servers join the same hostname by claiming `mcp.joshuamarble.io/<their-path>*` [route patterns](https://developers.cloudflare.com/workers/configuration/routing/routes/) in their own wrangler config — routes take precedence over the Custom Domain. The hostname's root `/` and any unclaimed path are served by the standalone [mcp-directory](https://github.com/jsmarble/mcp-directory) Worker via a catch-all `mcp.joshuamarble.io/*` route (specific server routes beat the wildcard); it renders a directory of every hosted server, and new servers register themselves there.

### Configuration reference

All configuration is optional:

| Setting | Where | Effect |
|---------|-------|--------|
| `SEATS_AERO_API_KEY` | secret (`wrangler secret put`) or `.dev.vars` | Fallback API key used when a request has no key header — for private single-user deployments. Leave unset on a shared/public server. A caller's header always takes precedence. |
| `ACCESS_TEAM_DOMAIN` + `ACCESS_APP_AUD` | `wrangler.jsonc` → `vars` | When **both** are set, every `/mcp` request must carry a valid Cloudflare Access JWT (see below). While unset — the default — the server is public. |

### Optional: restrict who can connect (Cloudflare Access)

The server is open by default; the only thing an unkeyed caller can consume is the Worker invocation itself. If you later want to restrict *who can reach the server at all*, the [Cloudflare Access (Zero Trust)](https://developers.cloudflare.com/cloudflare-one/) hook is already built in:

1. In [Zero Trust](https://one.dash.cloudflare.com/) → **Access → Applications**, add a **Self-hosted** application covering the Worker's public hostname (Access applies to hostnames on your Cloudflare zone, so use a custom domain/route).
2. Add a policy. For MCP clients that can't do an interactive login, create a **Service Token** (Access → Service Auth) and a policy with a **Service Auth** action; clients then send `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers alongside their API key header.
3. Copy the application's **Audience (AUD) tag** and your team domain into `wrangler.jsonc` → `vars` (`ACCESS_TEAM_DOMAIN`, `ACCESS_APP_AUD`) and redeploy.

Once set, the Worker verifies the `Cf-Access-Jwt-Assertion` JWT on every `/mcp` request — issuer, audience, expiry, and signature against your team's JWKS — and returns `401` otherwise, so Access can't be bypassed via a direct URL.

For a public deployment, a lighter-weight protection is a [WAF rate-limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on `/mcp` to cap per-IP request rates.

## Architecture

```
MCP client ──HTTPS──▶ Worker (/mcp)
(sends own API key)     ├─ (optional) validates Cloudflare Access JWT
                        ├─ reads caller's X-Seats-Aero-Api-Key header (401 if missing)
                        ├─ createMcpHandler() → McpServer (fresh per request)
                        └─ seats.aero Partner API (Partner-Authorization: <caller's key>)
```

- [src/index.ts](src/index.ts) — Worker entry: routes `/mcp` and `/health`, resolves the caller's API key
- [src/server.ts](src/server.ts) — MCP server and tool definitions (zod-validated inputs, read-only annotations)
- [src/seats-client.ts](src/seats-client.ts) — seats.aero API client (request timeouts, 401/429 handling)
- [src/access.ts](src/access.ts) — optional Cloudflare Access JWT validation (jose, JWKS cached per isolate)

### Development commands

```bash
npm run dev      # local dev server (wrangler dev)
npm run lint     # lint + format check (Biome); lint:fix to apply
npm run check    # typecheck src and tests (tsc --noEmit)
npm test         # vitest suite running inside the workerd runtime
npm run types    # regenerate worker-configuration.d.ts after wrangler.jsonc changes
npm run deploy   # manual deploy to Cloudflare (CI normally does this)
```

### CI/CD

Every push and pull request runs the quality gates in [`.github/workflows/ci.yml`](.github/workflows/ci.yml): Biome lint + format check, strict typecheck of source and tests, the full test suite executed inside the real `workerd` runtime with all outbound seats.aero traffic mocked (tests fail if anything tries to hit the network), and a `wrangler deploy --dry-run` bundle check.

Pushes to `main` that pass all gates deploy automatically via [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action) to the `production` environment, followed by a smoke test against the live URL (health check, keyless-401, and tools/list). Deploys never cancel mid-flight; queued deploys wait.

Repository secrets required for auto-deploy:

| Secret | Purpose | How to get it |
|--------|---------|---------------|
| `CLOUDFLARE_API_TOKEN` | Lets CI deploy the Worker | Cloudflare dashboard → My Profile → [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → **Edit Cloudflare Workers** template, scoped to your account. Then `gh secret set CLOUDFLARE_API_TOKEN` |
| `CLOUDFLARE_ACCOUNT_ID` | Target account | Cloudflare dashboard sidebar, or `wrangler whoami` |

While `CLOUDFLARE_API_TOKEN` is unset the deploy job is skipped (quality gates still run), so CI stays green on forks and fresh clones. Dependabot keeps npm dependencies and pinned GitHub Actions current with weekly grouped PRs.

## Privacy

- API keys are read from the request, forwarded to seats.aero over HTTPS, and never stored or logged by this server.
- No search data is persisted; the server is stateless and holds nothing between requests.
- Workers observability is enabled for operational logs (request metadata); key headers are not written to logs by the application.

## Disclaimer

This project is an independent, unofficial tool and is **not affiliated with, endorsed by, or in any way associated with seats.aero**. All data is retrieved through the seats.aero Partner API using each caller's own credentials.

Use of this software is subject to the [seats.aero Terms of Service](https://seats.aero/terms). You are solely responsible for ensuring your usage complies with their terms, including any restrictions on API usage, rate limits, and permitted use cases.

This software is provided "as is", without warranty of any kind. The author(s) are not liable for any damages, data loss, account suspension, or other consequences arising from the use of this software.

## Credits

Based on [cjmcenery/seats-aero-mcp](https://github.com/cjmcenery/seats-aero-mcp) (stdio version), converted to a public remote MCP server on Cloudflare Workers.

## License

MIT
