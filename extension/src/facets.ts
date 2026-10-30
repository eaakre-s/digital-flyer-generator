/**
 * Filter values and product counts for a fallback link, from Scheels Search, the index the site's
 * product listings read. The search files products under category paths ("All > … > Hiking Boots"),
 * not slugs, so a category is found by searching its name and taking the one path that ends in it;
 * when there is none (or several), values come from the whole catalogue and there is no count.
 */

import type { FallbackLink } from './link';
import { linkRefinements, refinementKeyOf } from './urlRules';

const SEARCH_URL = 'https://search.scheels.com/api/search';
const INDEX = 'commercetools_products';
const PATH_LEVELS = [2, 3, 4, 5, 6, 7];

async function search(query: Record<string, unknown>): Promise<any> {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queries: [
        {
          indexName: INDEX,
          branchName: 'search',
          query: '',
          page: 1,
          pageSize: 1,
          trackEvents: false,
          dynamicRerank: false,
          ...query,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Scheels Search answered ${res.status}.`);
  return (await res.json())?.results?.[0] ?? {};
}

const paths = new Map<string, Promise<string | null>>();

/** The category path ending in this category name, or null when no single path does. */
export function categoryPath(name: string): Promise<string | null> {
  const key = name.trim().toLowerCase();
  if (!paths.has(key)) {
    const found = search({ query: name, facets: PATH_LEVELS.map((n) => `categoryHierarchy.categories${n}`) })
      .then((result) => {
        const matches = Object.values(result.facets ?? {})
          .flatMap((facet: any) => Object.keys(facet?.values ?? {}))
          .filter((path) => path.split(' > ').pop()?.toLowerCase() === key);
        return matches.length === 1 ? matches[0] : null;
      })
      .catch(() => null);
    paths.set(key, found);
  }
  return paths.get(key)!;
}

const filterOf = (key: string, value: string) =>
  value.includes('"') ? `${key}:"${value.replace(/"/g, '\\"')}"` : `${key}:${value}`;

/** The search filters a link sets, as the site reads them; null when its category's path is unknown. */
export async function facetFilters(link: FallbackLink, name: string | undefined): Promise<string[][] | null> {
  const filters: string[][] = [];
  if (link.category) {
    const path = name ? await categoryPath(name) : null;
    if (!path) return null;
    filters.push([filterOf(`categoryHierarchy.categories${path.split(' > ').length}`, path)]);
  }
  const { refinementList, toggle } = linkRefinements(link);
  for (const [key, values] of Object.entries(refinementList)) filters.push(values.map((v) => filterOf(key, v)));
  for (const [key, on] of Object.entries(toggle)) if (on) filters.push([`${key}:true`]);
  return filters;
}

/** How many products the link lists, or null when that cannot be told (its category's path is unknown). */
export async function linkCount(link: FallbackLink, name: string | undefined): Promise<number | null> {
  const filters = await facetFilters(link, name);
  if (!filters) return null;
  const result = await search({ facetFilters: filters });
  return typeof result.totalHits === 'number' ? result.totalHits : null;
}

/**
 * The values one of the link's filters can take, most products first, with what the rest of the link
 * already narrows them to (the filter itself left out).
 */
export async function filterValues(
  attributeName: string,
  link: FallbackLink,
  name: string | undefined,
  skip: number,
): Promise<{ value: string; count: number }[]> {
  const others: FallbackLink = { ...link, attributes: (link.attributes ?? []).filter((_, i) => i !== skip) };
  const filters =
    (await facetFilters(others, name)) ?? (await facetFilters({ ...others, category: undefined }, undefined)) ?? [];
  const field = refinementKeyOf(attributeName);
  const result = await search({ facets: [field], facetFilters: filters });
  return Object.entries(result.facets?.[field]?.values ?? {})
    .map(([value, count]) => ({ value, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count);
}
