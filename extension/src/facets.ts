/**
 * Filter values and product counts for a fallback link, from Scheels Search, the index the site's
 * product listings read. The search files products under category paths ("All > … > Hiking Boots"),
 * not slugs, so a category is found by searching its name and taking the one path that ends in it;
 * when there is none (or several), values come from the whole catalogue and there is no count.
 */

import { searchMany } from './ace';
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

/** Item-list brand names mapped to the spelling Scheels Search files products under ("7Diamonds" → "7 Diamonds"). */
export type BrandSpellings = Map<string, string>;

const isBrand = (attributeName: string) => attributeName.trim().toLowerCase() === 'brand';
const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Whether one name is the other with a single letter added or dropped. */
function oneLetterApart(a: string, b: string): boolean {
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (long.length - short.length !== 1) return false;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}

// The same brand ignoring spaces, case and punctuation ("7Diamonds"), one name the other's first words
// ("Benchmade" for "Benchmade Knife Company"), or a letter doubled or dropped in a longer name ("Mizzzen + Main").
function sameBrand(wanted: string, listed: string): boolean {
  const a = squash(wanted);
  const b = squash(listed);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = words(wanted).length <= words(listed).length ? [words(wanted), words(listed)] : [words(listed), words(wanted)];
  if (short.join('').length >= 4 && short.every((w, i) => long[i] === w)) return true;
  return a.length >= 6 && oneLetterApart(a, b);
}

/** The brands these links filter on, each once. */
export const linkBrands = (links: FallbackLink[]) => [
  ...new Set(
    links.flatMap((link) =>
      (link.attributes ?? [])
        .filter((a) => isBrand(a.attributeName))
        .flatMap((a) => a.attributeValue.split('|').map((value) => value.trim()))
        .filter(Boolean),
    ),
  ),
];

/**
 * For each brand Scheels Search files no products under as written, its spelling there, found among the
 * brands a search for the name returns (the one with the most products when several are close). `unknown`
 * lists the brands with nothing close.
 */
export async function brandSpellings(brands: string[]): Promise<{ spellings: BrandSpellings; unknown: string[] }> {
  const key = refinementKeyOf('brand');
  const counts = await searchMany(
    brands.map((brand) => ({ pageSize: 1, attributesToRetrieve: ['objectID'], facetFilters: [[filterOf(key, brand)]] })),
  );
  const missing = brands.filter((_, i) => !Number(counts[i]?.totalHits));
  const found = await searchMany(missing.map((brand) => ({ query: brand, pageSize: 1, attributesToRetrieve: ['objectID'], facets: [key] })));
  const spellings: BrandSpellings = new Map();
  const unknown: string[] = [];
  missing.forEach((brand, i) => {
    const best = Object.entries(found[i]?.facets?.[key]?.values ?? {})
      .map(([value, count]) => ({ value, count: Number(count) || 0 }))
      .filter(({ value }) => sameBrand(brand, value))
      .sort((a, b) => b.count - a.count)[0];
    if (best) spellings.set(brand, best.value);
    else unknown.push(brand);
  });
  return { spellings, unknown };
}

/** The link with its brand filters spelled as Scheels Search spells them. */
export function respellBrands(link: FallbackLink, spellings?: BrandSpellings): FallbackLink {
  if (!spellings?.size || !link.attributes?.some((a) => isBrand(a.attributeName))) return link;
  return {
    ...link,
    attributes: link.attributes.map((a) =>
      isBrand(a.attributeName)
        ? { ...a, attributeValue: a.attributeValue.split('|').map((value) => spellings.get(value.trim()) ?? value.trim()).join('|') }
        : a,
    ),
  };
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
