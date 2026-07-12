// Shared limit/offset parsing for list endpoints. Unbounded `SELECT *` lists are a
// real payload risk once a tenant has thousands of rows (the doc quota alone is
// 10k), so every list clamps to a sane page size.
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export function pageParams(query: (name: string) => string | undefined): { limit: number; offset: number } {
  const rawLimit = Number(query('limit'))
  const rawOffset = Number(query('offset'))
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  return { limit, offset }
}
