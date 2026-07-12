import { createMcpHandler } from "agents/mcp";
import { enforceAccess } from "./access";
import { buildServer } from "./server";

const MCP_ROUTE = "/mcp";

/**
 * Resolves the seats.aero Partner API key for this request. Callers supply
 * their own key per-request via a header — nothing is stored server-side:
 *   X-Seats-Aero-Api-Key: <key>   (preferred)
 *   Partner-Authorization: <key>  (same header seats.aero itself uses)
 *   Authorization: Bearer <key>
 * The SEATS_AERO_API_KEY secret, if set, is a fallback for private
 * single-user deployments.
 */
function resolveApiKey(request: Request, env: Env): string | undefined {
  const headerKey =
    request.headers.get("X-Seats-Aero-Api-Key") ??
    request.headers.get("Partner-Authorization");
  if (headerKey?.trim()) return headerKey.trim();

  const auth = request.headers.get("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const bearer = auth.slice("bearer ".length).trim();
    if (bearer) return bearer;
  }

  return env.SEATS_AERO_API_KEY?.trim() || undefined;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === MCP_ROUTE) {
      const denied = await enforceAccess(request, env);
      if (denied) return denied;

      const apiKey = resolveApiKey(request, env);
      if (!apiKey) {
        return Response.json(
          {
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message:
                "No seats.aero API key provided. Send your Partner API key in an `X-Seats-Aero-Api-Key` header (or `Authorization: Bearer <key>`). Get a key from your seats.aero Pro account.",
            },
            id: null,
          },
          { status: 401 }
        );
      }

      // A fresh McpServer per request: the handler is stateless and the MCP
      // SDK forbids reconnecting an already-connected server instance.
      const server = buildServer(apiKey);
      return createMcpHandler(server, { route: MCP_ROUTE })(request, env, ctx);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        name: "seats-aero-mcp",
        status: "ok",
        endpoint: MCP_ROUTE,
        transport: "streamable-http",
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
