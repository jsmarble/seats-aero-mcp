/**
 * Directory of MCP servers hosted on the shared mcp.joshuamarble.io hostname.
 *
 * This Worker holds the hostname's Custom Domain, so its root `/` acts as the
 * index for every server on it. Add an entry here when a new server claims a
 * `mcp.joshuamarble.io/<name>*` route (see docs/MIGRATION_RUNBOOK.md).
 */

export interface McpServerEntry {
  name: string;
  /** URL path that is also the MCP endpoint, e.g. "/seats-aero". */
  path: string;
  description: string;
  auth: string;
  repo: string;
}

export const SERVERS: McpServerEntry[] = [
  {
    name: "seats.aero",
    path: "/seats-aero",
    description:
      "Award flight availability search via the seats.aero Partner API — cached and live search, routes, and trip details.",
    auth: "X-Seats-Aero-Api-Key header (your seats.aero Pro Partner API key)",
    repo: "https://github.com/jsmarble/seats-aero-mcp",
  },
  {
    name: "TripIt",
    path: "/tripit",
    description:
      "TripIt travel management — list and manage trips, flights, hotels, car rentals, activities, flight status, and loyalty programs.",
    auth: "X-TripIt-Consumer-Key/-Consumer-Secret/-Access-Token/-Access-Token-Secret headers (your TripIt OAuth 1.0 values)",
    repo: "https://github.com/jsmarble/tripit-mcp",
  },
];

export function directoryJson(origin: string) {
  return {
    name: "mcp.joshuamarble.io",
    description:
      "Public MCP (Model Context Protocol) servers, one per path. Bring your own API credentials — nothing is stored server-side.",
    transport: "streamable-http",
    servers: SERVERS.map((server) => ({
      name: server.name,
      endpoint: `${origin}${server.path}`,
      health: `${origin}${server.path}/health`,
      description: server.description,
      auth: server.auth,
      repo: server.repo,
    })),
  };
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function directoryHtml(origin: string): string {
  const rows = SERVERS.map((server) => {
    const endpoint = `${origin}${server.path}`;
    return `
    <section class="server">
      <h2>${escapeHtml(server.name)}</h2>
      <p>${escapeHtml(server.description)}</p>
      <p class="endpoint"><code>${escapeHtml(endpoint)}</code></p>
      <p class="auth">Auth: ${escapeHtml(server.auth)}</p>
      <p class="links">
        <a href="${escapeHtml(endpoint)}/health">health</a> ·
        <a href="${escapeHtml(server.repo)}">source &amp; setup docs</a>
      </p>
    </section>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP servers — mcp.joshuamarble.io</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 680px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.55;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    .tagline { color: light-dark(#555, #aaa); margin-top: 0; }
    .server {
      border: 1px solid light-dark(#ddd, #3a3a3a); border-radius: 10px;
      padding: 1rem 1.25rem; margin: 1.25rem 0;
    }
    .server h2 { margin: 0 0 0.35rem; font-size: 1.15rem; }
    .server p { margin: 0.35rem 0; }
    code {
      background: light-dark(#f2f2f2, #2a2a2a); padding: 2px 7px;
      border-radius: 5px; font-size: 0.9em; word-break: break-all;
    }
    .auth, .links { font-size: 0.9em; color: light-dark(#555, #aaa); }
    footer { font-size: 0.85em; color: light-dark(#777, #888); margin-top: 2rem; }
    a { color: light-dark(#0057b8, #7ab4ff); }
  </style>
</head>
<body>
  <h1>MCP servers</h1>
  <p class="tagline">Public Model Context Protocol servers over Streamable HTTP, one per path.
  Bring your own API credentials — nothing is stored server-side, and requests without
  credentials get a 401 with instructions.</p>
${rows}
  <footer>Connect from any MCP client that supports remote servers with custom headers
  (e.g. <code>claude mcp add --transport http &lt;name&gt; &lt;endpoint&gt; --header ...</code>).
  Each server's repo has copy-pasteable client configs. This index is also available as
  JSON (request without an <code>Accept: text/html</code> header).</footer>
</body>
</html>
`;
}
