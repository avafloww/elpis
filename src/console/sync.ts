/** Mutable console collections use stable ids. A patch carries replacement
 * records only for changed ids and the authoritative order (including removals).
 * Unchanged client records keep their identity, along with their mounted UI. */
type RecordValue = Record<string, unknown>;

export function collectionPatch(
  previous: RecordValue,
  next: RecordValue,
  key: string,
): RecordValue {
  const before = new Map(
    (previous[key] as RecordValue[]).map((row) => [
      row.id,
      JSON.stringify(row),
    ]),
  );
  const rows = next[key] as RecordValue[];
  return {
    ...next,
    [key]: rows.filter((row) => before.get(row.id) !== JSON.stringify(row)),
    order: rows.map((row) => row.id),
  };
}

export function applyCollectionPatch(
  previous: RecordValue,
  patch: RecordValue,
  key: string,
): RecordValue {
  const rows = new Map(
    (previous[key] as RecordValue[]).map((row) => [row.id, row]),
  );
  for (const row of patch[key] as RecordValue[]) rows.set(row.id, row);
  const { order, ...fields } = patch;
  return {
    ...fields,
    [key]: (order as unknown[]).flatMap((id) =>
      rows.has(id) ? [rows.get(id)!] : [],
    ),
  };
}
