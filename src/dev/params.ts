export interface DevParams {
  /** ?dev=1: open the tuning panel on load. */
  open: boolean;
  /** ?tune=<url-encoded JSON diff>: decoded JSON text, or null. */
  tune: string | null;
}

export function parseDevParams(search: string): DevParams {
  const q = new URLSearchParams(search);
  return { open: q.get('dev') === '1', tune: q.get('tune') };
}
