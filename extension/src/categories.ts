/**
 * Scheels categories by name, with the slug a link's Category field takes (Hiking Boots →
 * hiking-boots, as in /c/hiking-boots). From data/categories.csv, loaded the first time a category is
 * looked up; Flyer Studio's build reads the same file. Replace the file to refresh both.
 */

export interface Category {
  name: string;
  slug: string;
}

let loading: Promise<Category[]> | null = null;

export function loadCategories(): Promise<Category[]> {
  loading ??= import('../../data/categories.csv?raw').then((m) => parseCategories(m.default));
  return loading;
}

/** The rows of a `display_name,slug` CSV; a field is quoted when it holds a comma or a quote. */
export function parseCategories(text: string): Category[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header = [], ...body] = rows;
  const at = (name: string) => header.findIndex((h) => h.replace(/^﻿/, '').trim() === name);
  const nameAt = at('display_name');
  const slugAt = at('slug');
  return body
    .map((r) => ({ name: (r[nameAt] ?? '').trim(), slug: (r[slugAt] ?? '').trim() }))
    .filter((c) => c.name && c.slug);
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Categories whose name or slug has a word starting with each word typed, closest first: the exact
 * name, then names starting with what was typed, then names of fewer words, alphabetically. Kept in step
 * with Flyer Studio's.
 */
export function findCategories(list: Category[], query: string, limit = 10): Category[] {
  const typed = words(query);
  if (!typed.length) return [];
  const phrase = typed.join(' ');
  const found: { category: Category; rank: number }[] = [];
  for (const category of list) {
    const nameWords = words(category.name);
    const all = [...nameWords, ...category.slug.split('-')];
    if (!typed.every((t) => all.some((w) => w.startsWith(t)))) continue;
    const name = nameWords.join(' ');
    const rank = name === phrase || category.slug === query.trim().toLowerCase() ? 0 : name.startsWith(phrase) ? 1 : 2;
    found.push({ category, rank });
  }
  return found
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        words(a.category.name).length - words(b.category.name).length ||
        a.category.name.localeCompare(b.category.name),
    )
    .slice(0, limit)
    .map((f) => f.category);
}

/** The name of the category with this slug, or undefined when the list has none. */
export async function categoryName(slug: string | undefined): Promise<string | undefined> {
  if (!slug) return undefined;
  return (await loadCategories()).find((c) => c.slug === slug)?.name;
}
