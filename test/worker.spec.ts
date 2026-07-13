import { SELF } from "cloudflare:test";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "./server";

const MCP_URL = "https://example.com/mcp";
const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function rpc(method: string, params?: unknown, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

/** The subset of JSON-RPC result shapes these tests assert on. */
interface RpcEnvelope {
  result: {
    serverInfo: { name: string };
    tools: { name: string }[];
    content: { type: "text"; text: string }[];
    isError?: boolean;
  };
}

/** MCP responses over Streamable HTTP arrive as SSE; extract the JSON payload. */
async function readRpcResult(response: Response): Promise<RpcEnvelope> {
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`No SSE data line in response: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  key = "test-key",
): Promise<RpcEnvelope> {
  const response = await SELF.fetch(MCP_URL, {
    method: "POST",
    headers: { ...JSON_HEADERS, "X-Seats-Aero-Api-Key": key },
    body: rpc("tools/call", { name, arguments: args }),
  });
  expect(response.status).toBe(200);
  return readRpcResult(response);
}

describe("routing", () => {
  it("serves a health check without a key", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, string>>();
    expect(body.status).toBe("ok");
    expect(body.endpoint).toBe("/seats-aero");
  });

  it("returns 404 for unknown paths", async () => {
    const response = await SELF.fetch("https://example.com/nope");
    expect(response.status).toBe(404);
  });

  it("serves a JSON server directory at the hostname root", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    const body = await response.json<{
      servers: { name: string; endpoint: string }[];
    }>();
    const endpoints = body.servers.map((server) => server.endpoint);
    expect(endpoints).toContain("https://example.com/seats-aero");
    expect(endpoints).toContain("https://example.com/tripit");
  });

  it("serves an HTML server directory to browsers", async () => {
    const response = await SELF.fetch("https://example.com/", {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("MCP servers");
    expect(html).toContain("/seats-aero");
    expect(html).toContain("/tripit");
  });

  it("serves health under the base path", async () => {
    const response = await SELF.fetch("https://example.com/seats-aero/health");
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, string>>();
    expect(body.status).toBe("ok");
  });

  it("serves the MCP endpoint at the base path", async () => {
    const response = await SELF.fetch("https://example.com/seats-aero", {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Seats-Aero-Api-Key": "test-key" },
      body: rpc("tools/list"),
    });
    expect(response.status).toBe(200);
    const result = await readRpcResult(response);
    expect(result.result.tools.length).toBe(5);
  });

  it("keeps the legacy /mcp endpoint working alongside the base path", async () => {
    const response = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Seats-Aero-Api-Key": "test-key" },
      body: rpc("tools/list"),
    });
    expect(response.status).toBe(200);
  });
});

describe("API key handling", () => {
  it("rejects /mcp requests without a key", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: JSON_HEADERS,
      body: rpc("tools/list"),
    });
    expect(response.status).toBe(401);
    const body = await response.json<{ error: { message: string } }>();
    expect(body.error.message).toContain("X-Seats-Aero-Api-Key");
  });

  it("accepts a key via Authorization: Bearer", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: "Bearer test-key" },
      body: rpc("tools/list"),
    });
    expect(response.status).toBe(200);
  });
});

describe("MCP protocol", () => {
  it("completes the initialize handshake", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Seats-Aero-Api-Key": "test-key" },
      body: rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }),
    });
    expect(response.status).toBe(200);
    const result = await readRpcResult(response);
    expect(result.result.serverInfo.name).toBe("seats-aero");
  });

  it("lists all five seats.aero tools", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Seats-Aero-Api-Key": "test-key" },
      body: rpc("tools/list"),
    });
    const result = await readRpcResult(response);
    const names = result.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual([
      "search_availability",
      "bulk_availability",
      "get_trips",
      "get_routes",
      "live_search",
    ]);
  });

  it("rejects invalid tool arguments before calling seats.aero", async () => {
    const result = await callTool("search_availability", {
      origin_airport: "SFO",
      destination_airport: "NRT",
      start_date: "June 2026",
    });
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain("YYYY-MM-DD");
  });
});

describe("seats.aero integration", () => {
  it("forwards the caller's key and returns API data", async () => {
    let seenKey: string | null = null;
    server.use(
      http.get("https://seats.aero/partnerapi/routes", ({ request }) => {
        seenKey = request.headers.get("Partner-Authorization");
        return HttpResponse.json([{ ID: "r1", OriginAirport: "SFO" }]);
      }),
    );

    const result = await callTool("get_routes", { source: "united" }, "caller-key-123");
    expect(result.result.isError).toBeUndefined();
    expect(seenKey).toBe("caller-key-123");
    const data = JSON.parse(result.result.content[0].text);
    expect(data[0].OriginAirport).toBe("SFO");
  });

  it("applies the 50-result default page size to cached search", async () => {
    let seenTake: string | null = null;
    server.use(
      http.get("https://seats.aero/partnerapi/search", ({ request }) => {
        seenTake = new URL(request.url).searchParams.get("take");
        return HttpResponse.json({ data: [], count: 0 });
      }),
    );

    const result = await callTool("search_availability", {
      origin_airport: "SFO",
      destination_airport: "NRT",
    });
    expect(result.result.isError).toBeUndefined();
    expect(seenTake).toBe("50");
  });

  it("sends live searches as POST with a JSON body", async () => {
    let seenBody: unknown = null;
    server.use(
      http.post("https://seats.aero/partnerapi/live", async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ data: [] });
      }),
    );

    const result = await callTool("live_search", {
      origin_airport: "SFO",
      destination_airport: "NRT",
      departure_date: "2026-08-15",
      source: "united",
      seat_count: 2,
    });
    expect(result.result.isError).toBeUndefined();
    expect(seenBody).toMatchObject({
      origin_airport: "SFO",
      destination_airport: "NRT",
      departure_date: "2026-08-15",
      source: "united",
      seat_count: 2,
    });
  });

  it("surfaces upstream auth failures as tool errors, not crashes", async () => {
    server.use(
      http.get("https://seats.aero/partnerapi/routes", () =>
        HttpResponse.text("bad_partner_key", { status: 401 }),
      ),
    );

    const result = await callTool("get_routes", { source: "united" }, "wrong-key");
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain("rejected the API key");
  });

  it("surfaces rate limiting with retry guidance", async () => {
    server.use(
      http.get("https://seats.aero/partnerapi/routes", () =>
        HttpResponse.text("slow down", {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      ),
    );

    const result = await callTool("get_routes", { source: "united" });
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain("rate limit");
    expect(result.result.content[0].text).toContain("30");
  });
});
