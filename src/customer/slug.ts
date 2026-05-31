// Müşteri slug normalizasyonunun tek kaynağı — store ve card-reader buradan import eder.
export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}
