/**
 * Search over a bundled category's hosts. The category lists ship hundreds of entries each, so the
 * options and onboarding browsers render a page of them and let a search term reach the rest.
 */

/** Hosts rendered before a search term narrows the list. */
export const HOST_PAGE_SIZE: number = 50;

/** Splits a typed query into the terms every matching host has to contain. */
export function hostQueryTerms(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term: string): boolean => term.length > 0);
}

/** Hosts containing every term, in list order. An empty query matches the whole list. */
export function filterHosts(hosts: readonly string[], query: string): string[] {
  const terms: string[] = hostQueryTerms(query);
  if (terms.length === 0) return [...hosts];
  return hosts.filter((host: string): boolean => {
    const candidate: string = host.toLowerCase();
    return terms.every((term: string): boolean => candidate.includes(term));
  });
}
