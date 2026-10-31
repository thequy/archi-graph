// Source-link safety helpers (global constraint): entity.links[] render as
// EXTERNAL anchors with rel="noopener" and ONLY http(s) URLs survive. Anything
// else (javascript:, data:, mailto:, relative, malformed) is dropped so a
// crafted link in authored content can never become a script-execution or
// tab-nabbing vector.

import type { LinkRef } from '@archi-graph/shared';

/** True only for absolute http:// or https:// URLs. */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Keep only links whose URL is a safe http(s) absolute URL. */
export function safeLinks(links: readonly LinkRef[]): LinkRef[] {
  return links.filter((l) => isSafeHttpUrl(l.url));
}
