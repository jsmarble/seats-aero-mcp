const API_BASE = "https://seats.aero/partnerapi";

export type QueryParams = Record<
  string,
  string | number | boolean | undefined
>;

/** Error thrown for non-2xx responses from the seats.aero Partner API. */
export class SeatsAeroApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "SeatsAeroApiError";
  }
}

interface RequestOptions {
  params?: QueryParams;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Minimal fetch-based client for the seats.aero Partner API.
 * https://developers.seats.aero/reference/getting-started-p
 */
export class SeatsAeroClient {
  constructor(private readonly apiKey: string) {}

  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const { params, method = "GET", body, timeoutMs = 30_000 } = options;

    const url = new URL(`${API_BASE}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        "Partner-Authorization": this.apiKey,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    return response.json();
  }

  private async toApiError(response: Response): Promise<SeatsAeroApiError> {
    const status = response.status;
    const text = await response.text().catch(() => "");
    const detail = text.slice(0, 500);

    if (status === 401 || status === 403) {
      return new SeatsAeroApiError(
        `seats.aero rejected the API key (HTTP ${status}). Verify the key sent in the X-Seats-Aero-Api-Key header (or the server's fallback SEATS_AERO_API_KEY secret) is a valid Partner API key. ${detail}`,
        status
      );
    }

    if (status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const retryAfterSeconds = Number.isFinite(retryAfter)
        ? retryAfter
        : undefined;
      return new SeatsAeroApiError(
        `seats.aero rate limit exceeded (HTTP 429).${
          retryAfterSeconds ? ` Retry after ${retryAfterSeconds}s.` : ""
        } ${detail}`,
        status,
        retryAfterSeconds
      );
    }

    return new SeatsAeroApiError(
      `seats.aero API error (HTTP ${status}): ${detail || response.statusText}`,
      status
    );
  }
}
