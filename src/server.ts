import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SeatsAeroApiError, SeatsAeroClient } from "./seats-client";

const SERVER_VERSION = "2.0.0";

// Known mileage programs ("sources") per https://developers.seats.aero/reference/concepts-copy.
// Kept as a description rather than an enum so new programs work without a code change.
const KNOWN_SOURCES =
  "eurobonus, virginatlantic, aeromexico, american, delta, etihad, united, " +
  "emirates, aeroplan, alaska, velocity, qantas, connectmiles, azul, smiles, " +
  "flyingblue, jetblue, qatar, turkish, singapore, ethiopian, saudia, " +
  "finnair, lufthansa, frontier, spirit";

const CABINS = ["economy", "premium", "business", "first"] as const;
const REGIONS = [
  "North America",
  "South America",
  "Africa",
  "Asia",
  "Europe",
  "Oceania",
] as const;

// The API defaults to 500 results per page, which overwhelms an LLM context
// window. Default to a smaller page; callers can paginate or raise `take`.
const DEFAULT_TAKE = 50;

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format");

const takeParam = z
  .number()
  .int()
  .min(10)
  .max(1000)
  .optional()
  .describe(
    `Number of results per page (10-1000). Defaults to ${DEFAULT_TAKE}; increase only when you need exhaustive results.`,
  );

const cursorParam = z
  .number()
  .int()
  .optional()
  .describe(
    "Opaque pagination cursor from the `cursor` field of a previous response. Pass it together with `skip` to fetch subsequent pages.",
  );

const skipParam = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    "Number of results already retrieved for this search. Use with `cursor` to paginate; deduplicate results by their `ID` field.",
  );

const sourceParam = z
  .string()
  .describe(`Mileage program to query. Known sources: ${KNOWN_SOURCES}`);

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof SeatsAeroApiError
      ? error.message
      : error instanceof Error
        ? `Request failed: ${error.message}`
        : "Request failed with an unknown error";
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Builds a fresh McpServer wired to the seats.aero Partner API.
 *
 * A new instance must be created per request: createMcpHandler() is
 * stateless and the MCP SDK forbids reconnecting an already-connected server.
 */
export function buildServer(apiKey: string): McpServer {
  const client = new SeatsAeroClient(apiKey);

  const server = new McpServer({
    name: "seats-aero",
    version: SERVER_VERSION,
  });

  server.registerTool(
    "search_availability",
    {
      title: "Search cached award availability",
      description:
        "Search seats.aero's cached award flight availability between specific airports across all mileage programs. " +
        "Results are Availability summary objects (one per route/date/program) with per-cabin fields for economy (Y), " +
        "premium economy (W), business (J), and first (F): availability, mileage cost, remaining seats, and airlines. " +
        "Responses are paginated; use `cursor` + `skip` for more pages and deduplicate by `ID`. " +
        "Use `get_trips` with a result's `ID` for flight-level detail.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        origin_airport: z
          .string()
          .describe(
            'Origin airport IATA code(s), comma-delimited for multiple (e.g. "SFO" or "SFO,LAX")',
          ),
        destination_airport: z
          .string()
          .describe(
            'Destination airport IATA code(s), comma-delimited for multiple (e.g. "FRA" or "FRA,LHR")',
          ),
        start_date: dateString.optional().describe("Earliest departure date, YYYY-MM-DD"),
        end_date: dateString.optional().describe("Latest departure date, YYYY-MM-DD"),
        cabins: z
          .string()
          .optional()
          .describe(
            'Required cabin(s), comma-delimited (e.g. "business" or "business,first"). Options: economy, premium, business, first',
          ),
        sources: z
          .string()
          .optional()
          .describe(
            `Mileage program(s) to include, comma-delimited (e.g. "united,aeroplan"). Known sources: ${KNOWN_SOURCES}`,
          ),
        carriers: z
          .string()
          .optional()
          .describe(
            'Only return results involving these comma-separated carrier codes (e.g. "DL,AA")',
          ),
        only_direct_flights: z
          .boolean()
          .optional()
          .describe(
            "Only return results with a direct flight available (default: false)",
          ),
        include_trips: z
          .boolean()
          .optional()
          .describe(
            "Include flight-level trip details in each result. Significantly increases response size (default: false)",
          ),
        minify_trips: z
          .boolean()
          .optional()
          .describe(
            "With include_trips, return a reduced set of fields per trip to shrink the response",
          ),
        order_by: z
          .enum(["lowest_mileage"])
          .optional()
          .describe(
            "Sort by cheapest mileage cost first. Omit for the default ordering (departure date, premium cabins ranked higher)",
          ),
        take: takeParam,
        cursor: cursorParam,
        skip: skipParam,
        include_filtered: z
          .boolean()
          .optional()
          .describe(
            "Include dynamically-priced results normally filtered out as expensive (default: false)",
          ),
      },
    },
    async (args) => {
      try {
        return jsonResult(
          await client.request("/search", {
            params: { ...args, take: args.take ?? DEFAULT_TAKE },
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "bulk_availability",
    {
      title: "Bulk availability for one mileage program",
      description:
        "Retrieve a large amount of cached award availability for a single mileage program, optionally filtered by " +
        "cabin, date range, and origin/destination region. Use this to explore everything a program offers " +
        "(e.g. all Delta SkyMiles availability from North America to Europe); use `search_availability` for " +
        "specific airport pairs. Paginated via `cursor` + `skip`; deduplicate by `ID`.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        source: sourceParam,
        cabin: z
          .enum(CABINS)
          .optional()
          .describe("Only return results with this cabin available"),
        start_date: dateString.optional().describe("Earliest departure date, YYYY-MM-DD"),
        end_date: dateString.optional().describe("Latest departure date, YYYY-MM-DD"),
        origin_region: z
          .enum(REGIONS)
          .optional()
          .describe("Only return results originating in this region"),
        destination_region: z
          .enum(REGIONS)
          .optional()
          .describe("Only return results arriving in this region"),
        take: takeParam,
        cursor: cursorParam,
        skip: skipParam,
        include_filtered: z
          .boolean()
          .optional()
          .describe(
            "Include dynamically-priced results normally filtered out as expensive (default: false)",
          ),
      },
    },
    async (args) => {
      try {
        return jsonResult(
          await client.request("/availability", {
            params: { ...args, take: args.take ?? DEFAULT_TAKE },
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_trips",
    {
      title: "Get flight-level trips for an availability result",
      description:
        "Get flight-level trip details for one Availability object: individual segments with flight numbers, " +
        "aircraft, departure/arrival times (airport-local), fare class, plus total mileage cost, taxes, duration, " +
        "stops, and remaining seats. Pass the `ID` of a result from `search_availability` or `bulk_availability`. " +
        "IDs returned by `live_search` are not real and will not work here.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        availability_id: z
          .string()
          .describe(
            "The `ID` field of an Availability object from search_availability or bulk_availability",
          ),
        include_filtered: z
          .boolean()
          .optional()
          .describe(
            "Include expensive dynamically-priced trips that are filtered out by default (default: false)",
          ),
      },
    },
    async ({ availability_id, include_filtered }) => {
      try {
        return jsonResult(
          await client.request(`/trips/${encodeURIComponent(availability_id)}`, {
            params: { include_filtered },
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_routes",
    {
      title: "List routes tracked for a mileage program",
      description:
        "List all routes seats.aero tracks for a mileage program: origin/destination airport pairs with their " +
        "regions and distances. Useful for discovering what can be searched for a given program.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        source: sourceParam,
      },
    },
    async ({ source }) => {
      try {
        return jsonResult(await client.request("/routes", { params: { source } }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "live_search",
    {
      title: "Live award search (real-time)",
      description:
        "Search a mileage program in real time for a specific airport pair and date — any city pair, not just " +
        "tracked routes. More accurate than cached search but slow (5-15s) and quota-limited. Returns only trip " +
        "objects (no Availability summaries); the IDs in the response are not usable with other tools. " +
        "NOTE: requires a commercial seats.aero API agreement — Pro-tier keys cannot use live search and will get " +
        "an error. Live searches can fail transiently (e.g. the airline is down); retry sparingly with backoff.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        origin_airport: z.string().describe('Origin airport IATA code (e.g. "SFO")'),
        destination_airport: z
          .string()
          .describe('Destination airport IATA code (e.g. "NRT")'),
        departure_date: dateString.describe("Departure date, YYYY-MM-DD"),
        source: sourceParam,
        cabin: z.enum(CABINS).optional().describe("Filter results to this cabin"),
        seat_count: z
          .number()
          .int()
          .min(1)
          .max(9)
          .optional()
          .describe("Number of adult passengers, 1-9 (default: 1)"),
        disable_filters: z
          .boolean()
          .optional()
          .describe(
            "Disable all result filters, including dynamic pricing and mismatched-airport filters (default: false)",
          ),
        show_dynamic_pricing: z
          .boolean()
          .optional()
          .describe(
            "Disable only the dynamic-pricing filter, keeping mismatched-airport filters (default: false)",
          ),
      },
    },
    async (args) => {
      try {
        return jsonResult(
          await client.request("/live", {
            method: "POST",
            body: args,
            timeoutMs: 60_000,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
