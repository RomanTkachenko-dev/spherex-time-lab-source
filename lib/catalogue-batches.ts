export const MAX_CATALOGUE_CHUNK_FRAMES = 60;
export const MAX_CATALOGUE_PARTS = 256;
export const MAX_SERIES_FRAMES = MAX_CATALOGUE_CHUNK_FRAMES * MAX_CATALOGUE_PARTS;
export const MAX_MOST_INTERVAL_DAYS = 90;

export type DateInterval = { start: string; end: string };

export function inclusiveIntervalDays({ start, end }: DateInterval): number {
  const first = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return 0;
  return Math.round((last - first) / 86_400_000) + 1;
}

/** Split an inclusive UTC date interval into contiguous, non-overlapping halves. */
export function splitDateInterval({ start, end }: DateInterval): [DateInterval, DateInterval] | null {
  const first = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return null;
  const days = Math.round((last - first) / 86_400_000);
  const middle = new Date(first + Math.floor(days / 2) * 86_400_000).toISOString().slice(0, 10);
  const next = new Date(Date.parse(`${middle}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return [{ start, end: middle }, { start: next, end }];
}

export type CatalogueRecord = { id: string; observation?: string; detector?: number; mjd: number; url?: string; target_ra?: number; target_dec?: number };

/** Merge repeated rows from adjacent archive responses and keep deterministic time order. */
export function mergeCatalogueRecords<T extends CatalogueRecord>(parts: readonly { records: readonly T[] }[]): T[] {
  const unique = new Map<string, T>();
  for (const part of parts) for (const record of part.records) {
    const key = record.observation
      ? `${record.observation}/D${record.detector ?? ""}`
      : record.url || record.id;
    if (!unique.has(key)) unique.set(key, record);
  }
  return [...unique.values()].sort((a, b) => a.mjd - b.mjd || a.id.localeCompare(b.id));
}

export type CatalogueBatchBody<T extends CatalogueRecord> = { records: T[]; error?: string };
export type CatalogueBatchPart<T extends CatalogueRecord, B extends CatalogueBatchBody<T>> = { interval: DateInterval; body: B };

export async function collectCatalogueParts<T extends CatalogueRecord, B extends CatalogueBatchBody<T>>({
  interval,
  movingObject,
  request,
  onProgress,
  unavailableRetryDelaysMs,
  sleep,
}: {
  interval: DateInterval;
  movingObject: boolean;
  request: (interval: DateInterval) => Promise<{ status: number; ok: boolean; body: B }>;
  onProgress?: (progress: { completed: number; total: number; detail: string }) => void;
  /** Extra waits after the server's own retries when the archive stays unavailable (HTTP 502/503). */
  unavailableRetryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ parts: CatalogueBatchPart<T, B>[]; records: T[] }> {
  const pending: DateInterval[] = [interval];
  const parts: CatalogueBatchPart<T, B>[] = [];
  while (pending.length) {
    const current = pending.shift()!;
    const halves = splitDateInterval(current);
    const mustRespectMostWindow = movingObject && inclusiveIntervalDays(current) > MAX_MOST_INTERVAL_DAYS;
    if (mustRespectMostWindow) {
      if (!halves || parts.length + pending.length + halves.length > MAX_CATALOGUE_PARTS) throw Error(`Період IRSA MOST потребує понад ${MAX_CATALOGUE_PARTS} частин. Звузьте дати й повторіть запит.`);
      pending.unshift(...halves);
      onProgress?.({ completed: parts.length, total: parts.length + pending.length, detail: `IRSA MOST приймає до ${MAX_MOST_INTERVAL_DAYS} діб за запит; автоматично ділю часовий інтервал…` });
      continue;
    }
    let response = await request(current);
    const delays = unavailableRetryDelaysMs ?? [4000, 10000];
    for (let retry = 0; retry < delays.length && (response.status === 502 || response.status === 503) && (response.body as { retryable?: boolean }).retryable !== false; retry++) {
      onProgress?.({ completed: parts.length, total: parts.length + pending.length + 1, detail: `IRSA тимчасово недоступний; повторна спроба ${retry + 1}/${delays.length} через ${Math.round(delays[retry] / 1000)} с…` });
      await (sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(delays[retry]);
      response = await request(current);
    }
    if (response.status === 413) {
      if (!halves) throw Error(`${response.body.error || "Архівна відповідь перевищила ліміт."} Навіть за одну UTC-добу збігів забагато для повного запиту; звузьте поле або додайте наукові фільтри.`);
      if (parts.length + pending.length + halves.length > MAX_CATALOGUE_PARTS) throw Error(`Пошук потребує понад ${MAX_CATALOGUE_PARTS} частин. Звузьте період і повторіть запит.`);
      pending.unshift(...halves);
      onProgress?.({ completed: parts.length, total: parts.length + pending.length, detail: `Архівний інтервал ${current.start}—${current.end} завеликий; автоматично ділю запит за UTC-датами…` });
      continue;
    }
    if (!response.ok) throw Error(response.body.error || "Запит до архіву не виконано.");
    if (!Array.isArray(response.body.records)) throw Error("Некоректна відповідь архіву.");
    parts.push({ interval: current, body: response.body });
    const records = mergeCatalogueRecords(parts.map(part => part.body));
    if (records.length > MAX_SERIES_FRAMES) throw Error(`Знайдено понад ${MAX_SERIES_FRAMES} унікальних кадрів. Поточна серія обмежена ${MAX_SERIES_FRAMES} кадрами; звузьте період або наукові фільтри.`);
    onProgress?.({ completed: parts.length, total: parts.length + pending.length, detail: pending.length ? `Отримано ${records.length} унікальних кадрів; триває пошук у ${pending.length} часових частинах…` : `Каталог зібрано: ${records.length} унікальних кадрів у ${parts.length} частинах.` });
  }
  return { parts, records: mergeCatalogueRecords(parts.map(part => part.body)) };
}
