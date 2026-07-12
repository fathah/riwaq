// Canonical UUID shape check. Path params flow straight into `uuid`-typed columns;
// a non-UUID value makes Postgres raise `22P02 invalid input syntax`, which without
// this guard surfaces as an opaque 500. Validating first lets routes return a clean
// 404 (resource not found) instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
