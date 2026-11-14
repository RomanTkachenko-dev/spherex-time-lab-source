import { parseVOTable } from "./votable.ts";

type FailureCode = "IRSA_UNAVAILABLE" | "IRSA_TIMEOUT" | "IRSA_NETWORK" | "IRSA_RESPONSE";

export class IrsaCatalogueError extends Error {
  code: FailureCode;
  upstreamStatus: number | null;
  retryable: boolean;
  constructor(code: FailureCode, upstreamStatus: number | null = null) {
    const messages: Record<FailureCode, string> = {
      IRSA_UNAVAILABLE: `Сервіс пошуку спостережень IRSA тимчасово недоступний (HTTP ${upstreamStatus}). Це збій архівного сервісу; звуження дат його не усуне. Повторіть пошук пізніше. Збережені серії залишаються доступними.`,
      IRSA_TIMEOUT: "IRSA не встиг відповісти на запит. Повторіть пошук; якщо очікування знову завершиться, спробуйте коротший період.",
      IRSA_NETWORK: "Не вдалося встановити з’єднання з IRSA. Перевірте доступ до мережі та повторіть пошук пізніше.",
      IRSA_RESPONSE: `IRSA повернув відповідь, яку неможливо використати як каталог${upstreamStatus === null ? "" : ` (HTTP ${upstreamStatus})`}. Повторіть пошук пізніше.`,
    };
    super(messages[code]);
    this.name = "IrsaCatalogueError";
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.retryable = code !== "IRSA_RESPONSE";
  }
}

/** IRSA's SIA gateway returns short bursts of 502/503; observed bursts last a few seconds. */
export const IRSA_ATTEMPTS = 4;
/** Pause before retry `attempt` (1-based): base · 2.2^(attempt−1), jittered ±25% so parallel clients spread out. */
export function retryDelay(attempt: number, baseMs: number, random = Math.random) {
  return Math.round(baseMs * 2.2 ** (attempt - 1) * (0.75 + 0.5 * random()));
}

/** Retries transient failures (gateway errors, network) within a single overall deadline.
 * Keep the original URL and raw XML so provenance and overflow are unchanged.
 */
export async function fetchIrsaCatalogue(
  url: string,
  options: { timeoutMs?: number; fetcher?: typeof fetch; retryDelayMs?: number; random?: () => number } = {},
) {
  const fetcher = options.fetcher ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 45000);
  for (let attempt = 0; attempt < IRSA_ATTEMPTS; attempt++) {
    try {
      const response = await fetcher(url, { signal, cache: "no-store", headers: { Accept: "application/x-votable+xml" } });
      if (!response.ok) {
        // Release the error body before another request. Do not expose upstream HTML.
        await response.body?.cancel();
        throw new IrsaCatalogueError([502, 503, 504].includes(response.status) ? "IRSA_UNAVAILABLE" : "IRSA_RESPONSE", response.status);
      }
      const xml = await response.text();
      try { return { xml, parsed: parseVOTable(xml) }; }
      catch { throw new IrsaCatalogueError("IRSA_RESPONSE"); }
    } catch (cause) {
      const error = signal.aborted
        ? new IrsaCatalogueError("IRSA_TIMEOUT")
        : cause instanceof IrsaCatalogueError ? cause : new IrsaCatalogueError("IRSA_NETWORK");
      if (attempt === IRSA_ATTEMPTS - 1 || !error.retryable || signal.aborted) throw error;
      await new Promise(resolve => setTimeout(resolve, retryDelay(attempt + 1, options.retryDelayMs ?? 600, options.random)));
      if (signal.aborted) throw new IrsaCatalogueError("IRSA_TIMEOUT");
    }
  }
  throw new IrsaCatalogueError("IRSA_UNAVAILABLE");
}

export function irsaCatalogueErrorResponse(cause: unknown) {
  const error = cause instanceof IrsaCatalogueError ? cause : new IrsaCatalogueError("IRSA_RESPONSE");
  return Response.json(
    { error: error.message, code: error.code, upstream_status: error.upstreamStatus, retryable: error.retryable },
    { status: error.code === "IRSA_TIMEOUT" ? 504 : 502, headers: { "Cache-Control": "no-store", ...(error.retryable ? { "Retry-After": "30" } : {}) } },
  );
}
