# seats-aero-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for the [seats.aero](https://seats.aero) Partner API. Lets AI assistants like Claude search for award flight availability in real time.

Runs on **Cloudflare Workers**, protected by **Cloudflare Zero Trust / Access OAuth**.

> **Requires a seats.aero Pro subscription** to get an API key.

## Tools

| Tool | Description |
|------|-------------|
| `search_availability` | Search cached award availability between airports across all cabins and programs |
| `bulk_availability` | Get all cached availability for a specific mileage program |
| `get_trips` | Get detailed flight segments for a specific availability result |
| `get_routes` | List all routes tracked by seats.aero for a given mileage program |
| `live_search` | Real-time search querying the mileage program directly (slower, uses more quota) |

## Deployment

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) with Workers enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) authenticated (`wrangler login`)
- seats.aero Pro subscription for an API key
- Cloudflare Zero Trust with an Access Application configured for OAuth

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets

Set the three required secrets via Wrangler (these are never stored in source control):

```bash
wrangler secret put SEATS_AERO_API_KEY
wrangler secret put CF_ACCESS_TEAM_DOMAIN   # e.g. your-team.cloudflareaccess.com
wrangler secret put CF_ACCESS_AUD           # Application Audience tag from Zero Trust dashboard
```

The `CF_ACCESS_AUD` value comes from **Zero Trust → Access → Applications → your app → Overview**.

### 3. Deploy

```bash
npm run deploy
```

The Worker is now live at `https://seats-aero-mcp.<your-subdomain>.workers.dev`.

### 4. Configure Cloudflare Access

In the Zero Trust dashboard, create (or update) an Access Application that protects `https://seats-aero-mcp.<your-subdomain>.workers.dev/*` with your OAuth provider. The Worker validates the `Cf-Access-Jwt-Assertion` header on every request and rejects any request that is not signed by your Access team.

### 5. Connect an MCP client

Configure your MCP client (e.g. Claude Desktop) to use the HTTP transport pointing at your Worker URL:

```json
{
  "mcpServers": {
    "seats-aero": {
      "type": "http",
      "url": "https://seats-aero-mcp.<your-subdomain>.workers.dev/mcp"
    }
  }
}
```

Clients that support Cloudflare Access OAuth will handle the authentication flow automatically.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in real values, then run:

```bash
npm run dev
```

Wrangler loads `.dev.vars` automatically for local secrets. Note: CF Access JWT validation is enforced even locally — disable it by temporarily removing the auth check in `src/index.ts` if needed, or by providing a valid local JWT.

## Architecture

- **Runtime**: Cloudflare Workers (Web-standard fetch handler)
- **MCP transport**: `WebStandardStreamableHTTPServerTransport` (stateless HTTP mode)
- **Auth**: Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header) validated via JWKS using Web Crypto API
- **API calls**: Native `fetch` (no Node.js dependencies)

Each request creates a fresh MCP server and transport instance — no persistent state is required.

## Usage examples

- *"Find business class award availability from SFO to Tokyo in June"*
- *"Search for United miles availability from LAX to London next month"*
- *"What routes does Aeroplan track from North America to Europe?"*
- *"Do a live search for ANA first class from JFK to NRT on 2025-08-15 using United miles"*

## Disclaimer

This project is an independent, unofficial tool and is **not affiliated with, endorsed by, or in any way associated with seats.aero**. All data is retrieved through the seats.aero Partner API using your own credentials.

Use of this software is subject to the [seats.aero Terms of Service](https://seats.aero/terms). You are solely responsible for ensuring your usage complies with their terms.

## License

MIT
