import { validateFieldQuery, type FieldQuery } from "./field-query.ts";
import { MAX_SERIES_FRAMES, mergeCatalogueRecords, type CatalogueBatchPart, type CatalogueRecord } from "./catalogue-batches.ts";

export type CatalogueArchiveResponse<T extends CatalogueRecord> = {
  records: T[];
  query?: FieldQuery | null;
  source_url: string;
  source_sha256: string;
  retrieved_at: string;
  matched_count: number;
  candidate_count: number;
  catalogue_truncated: boolean;
  selection: string;
  truncated?: boolean;
  error?: string;
};

export type CataloguePartProvenance = {
  start: string;
  end: string;
  source_url: string;
  source_sha256: string;
  retrieved_at: string;
  matched_count: number;
};

export function assembleCatalogueParts<T extends CatalogueRecord, B extends CatalogueArchiveResponse<T>>(
  parts: readonly CatalogueBatchPart<T, B>[],
  overall: { start: string; end: string },
  movingObject: boolean,
) {
  if (!parts.length) throw Error("Архів не повернув жодної часової частини.");
  const records = mergeCatalogueRecords(parts.map(part => part.body));
  if (records.length > MAX_SERIES_FRAMES) throw Error(`Знайдено понад ${MAX_SERIES_FRAMES} унікальних кадрів. Поточна серія обмежена ${MAX_SERIES_FRAMES} кадрами; звузьте період або наукові фільтри.`);
  const first = parts[0].body;
  const seed = parts.find(part => part.body.query)?.body.query;
  if (records.length >= 2 && !seed) throw Error("Архів повернув кадри без достатніх метаданих запиту.");
  const centre = movingObject && records.length ? records[Math.floor(records.length / 2)] : undefined;
  const query = seed ? validateFieldQuery({
    ...seed,
    start: overall.start,
    end: overall.end,
    max_frames: MAX_SERIES_FRAMES,
    ...(centre?.target_ra !== undefined && centre.target_dec !== undefined ? { ra: centre.target_ra, dec: centre.target_dec } : {}),
    ...(movingObject && seed.most ? { most: { ...seed.most, match_count: records.length } } : {}),
  }) : null;
  const observation_table_parts: CataloguePartProvenance[] = parts.map(({ interval, body }) => ({
    ...interval,
    source_url: body.source_url,
    source_sha256: body.source_sha256,
    retrieved_at: body.retrieved_at,
    matched_count: body.matched_count,
  }));
  return {
    ...first,
    query,
    records,
    matched_count: records.length,
    candidate_count: records.length,
    catalogue_truncated: parts.some(part => part.body.catalogue_truncated),
    truncated: false,
    selection: parts.length === 1 ? first.selection : `Усі унікальні збіги з ${parts.length} неперекривних інтервалів UTC; URL і SHA-256 кожної відповіді збережено в паспорті.`,
    observation_table_parts,
  };
}
