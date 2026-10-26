/**
 * "Latest request wins" helper.
 *
 * Every new request gets a higher sequence number and aborts the previous
 * one. A response is applied only if its number is still the latest, so a
 * slow answer for an old slider value can never overwrite a newer one.
 */
export interface Ticket {
  id: number;
  signal: AbortSignal;
}

export function createLatestOnly() {
  let seq = 0;
  let controller: AbortController | null = null;
  return {
    next(): Ticket {
      controller?.abort();
      controller = new AbortController();
      seq += 1;
      return { id: seq, signal: controller.signal };
    },
    isLatest(id: number): boolean {
      return id === seq;
    },
    cancel(): void {
      controller?.abort();
      controller = null;
      seq += 1;
    },
  };
}
