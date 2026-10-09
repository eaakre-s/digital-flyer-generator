import { fetchProducts, searchBatch, type Candidate } from './ace';
import type { FlyerPage, Hotspot } from './flyer';

/**
 * Edits the flyer already saved on the item: page images with their hotspots drawn on top. Boxes can
 * be moved, resized, drawn and deleted; a hotspot's text, fallback link and products can be changed,
 * with products found through Scheels Search. Every change is written to the field; the author saves
 * the item as usual.
 */

interface EditorDeps {
  write: (pages: FlyerPage[]) => Promise<string | null>;
  readOnly: () => boolean;
  /** Tells Amplience the frame's content height changed (an image finishing loading is not a DOM change). */
  resize: () => void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElement => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hasProduct = (hotspot: Hotspot) => hotspot.skus.length > 0;
const round1 = (v: number) => Math.round(v * 10) / 10;

const state = {
  pages: [] as FlyerPage[],
  page: 0,
  selected: -1,
  drawing: false,
  products: new Map<string, Candidate>(),
  searchResults: [] as Candidate[],
  searchQuery: '',
  confirmDelete: false,
  // Width / height of the last page image, so a new page keeps its space while its image loads.
  aspect: 0,
};
let deps: EditorDeps;
let writeTimer = 0;

const hotspots = () => state.pages[state.page]?.hotspots ?? [];
const selectedHotspot = (): Hotspot | undefined => hotspots()[state.selected];

function setStatus(text: string, kind: 'info' | 'error' | 'ok' = 'info') {
  const status = $('edStatus');
  status.textContent = text;
  status.dataset.kind = kind;
}

/** Writes after a short pause so a drag or a run of keystrokes is one write. */
function changed(hotspot?: Hotspot) {
  if (hotspot) hotspot.locked = true;
  setStatus('Changed. Save the item to keep it.');
  window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(async () => {
    const error = await deps.write(structuredClone(state.pages));
    if (error) setStatus(error, 'error');
  }, 400);
}

async function loadProductNames(ids: string[]) {
  const missing = [...new Set(ids)].filter((id) => !state.products.has(id));
  if (!missing.length) return;
  try {
    for (const product of await fetchProducts(missing)) state.products.set(product.objectID, product);
    renderInspector();
  } catch {
    // Names are a convenience; ids still show.
  }
}

// ---------- page and boxes ----------

function imageUrl(page: FlyerPage) {
  const image = page.image;
  return image ? `https://${image.defaultHost}/i/${image.endpoint}/${encodeURIComponent(image.name)}?w=1000` : '';
}

function renderPageControls() {
  const select = $('edPageSelect') as HTMLSelectElement;
  const labels = state.pages.map((page, i) => {
    const missing = page.hotspots.filter((h) => !hasProduct(h)).length;
    return [`Page ${i + 1}`, count(page.hotspots.length, 'hotspot'), missing && `${missing} without a product`, !page.image && 'no image']
      .filter(Boolean)
      .join(' · ');
  });
  // Rebuilt every render so the counts follow added and deleted boxes.
  select.replaceChildren(...labels.map((label, i) => el('option', { value: String(i), textContent: label })));
  select.value = String(state.page);

  const all = state.pages.flatMap((page) => page.hotspots);
  const missing = all.filter((h) => !hasProduct(h)).length;
  $('edSummary').textContent = [
    count(state.pages.length, 'page'),
    count(all.length, 'hotspot'),
    missing && `${missing} without a product`,
  ]
    .filter(Boolean)
    .join(' · ');
  ($('edPrev') as HTMLButtonElement).disabled = state.page === 0;
  ($('edNext') as HTMLButtonElement).disabled = state.page >= state.pages.length - 1;
  const draw = $('edDraw') as HTMLButtonElement;
  draw.disabled = deps.readOnly();
  draw.setAttribute('aria-pressed', String(state.drawing));
}

function renderSheet() {
  const sheet = $('edSheet');
  sheet.replaceChildren();
  sheet.classList.toggle('drawing', state.drawing);
  const page = state.pages[state.page];
  if (!page) return;
  if (!page.image) {
    sheet.style.aspectRatio = '';
    sheet.append(el('p', { className: 'muted empty', textContent: 'This page’s image is not published yet. Publish it and import again to show it.' }));
    return;
  }
  if (state.aspect) sheet.style.aspectRatio = String(state.aspect);
  const img = el('img', { src: imageUrl(page), alt: `Flyer page ${state.page + 1}`, draggable: false }) as HTMLImageElement;
  img.addEventListener('load', () => {
    state.aspect = img.naturalWidth / img.naturalHeight;
    sheet.style.aspectRatio = String(state.aspect);
    deps.resize();
  });
  sheet.append(img);
  page.hotspots.forEach((h, i) => {
    const linked = hasProduct(h);
    const box = el('button', {
      type: 'button',
      className: `hs ${linked ? 'linked' : 'unlinked'}`,
      title: h.label,
    });
    box.setAttribute('aria-pressed', String(i === state.selected));
    box.setAttribute('aria-label', `Hotspot ${i + 1}: ${h.label || 'unnamed'}${linked ? '' : ', no product'}`);
    box.dataset.idx = String(i);
    Object.assign(box.style, { left: `${h.box.x}%`, top: `${h.box.y}%`, width: `${h.box.w}%`, height: `${h.box.h}%` });
    box.append(el('span', { className: 'n', textContent: String(i + 1) }), el('span', { className: 'grip', ariaHidden: 'true' }));
    sheet.append(box);
  });
}

// ---------- inspector ----------

function field(label: string, input: HTMLElement) {
  return el('label', { className: 'f' }, el('span', { textContent: label }), input);
}

function productRow(hotspot: Hotspot, index: number) {
  const objectId = hotspot.objectIds?.[index];
  const product = objectId ? state.products.get(objectId) : undefined;
  const name = product?.title ?? (objectId ? `Product ${objectId}` : 'Product');
  const remove = el('button', { type: 'button', className: 'link', textContent: 'Remove', disabled: deps.readOnly() });
  remove.setAttribute('aria-label', `Remove ${product?.title ?? hotspot.skus[index]}`);
  remove.addEventListener('click', () => {
    hotspot.skus.splice(index, 1);
    hotspot.objectIds?.splice(index, 1);
    changed(hotspot);
    render();
  });
  return el('li', {}, el('span', { textContent: name }), el('span', { className: 'sku', textContent: `SKU ${hotspot.skus[index]}` }), remove);
}

function renderSearch(hotspot: Hotspot) {
  const wrap = el('div', { className: 'search' });
  const input = el('input', { type: 'search', value: state.searchQuery || hotspot.label, id: 'edSearch' }) as HTMLInputElement;
  const go = el('button', { type: 'button', textContent: 'Find product', disabled: deps.readOnly() });
  const run = async () => {
    state.searchQuery = input.value.trim();
    if (!state.searchQuery) return;
    go.textContent = 'Searching…';
    try {
      [state.searchResults] = await searchBatch([state.searchQuery]);
    } catch {
      state.searchResults = [];
      setStatus('Scheels Search could not be reached.', 'error');
    }
    renderInspector();
    $('edSearch')?.focus();
  };
  go.addEventListener('click', run);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      run();
    }
  });
  wrap.append(el('div', { className: 'row' }, field('Search Scheels', input), go));

  if (state.searchResults.length) {
    const list = el('ul', { className: 'results' });
    for (const candidate of state.searchResults) {
      const added = hotspot.objectIds?.includes(candidate.objectID);
      const add = el('button', { type: 'button', className: 'link', textContent: added ? 'Added' : 'Add', disabled: added || deps.readOnly() });
      add.addEventListener('click', () => {
        hotspot.skus = [...hotspot.skus, candidate.sku];
        hotspot.objectIds = [...(hotspot.objectIds ?? []), candidate.objectID];
        state.products.set(candidate.objectID, candidate);
        changed(hotspot);
        render();
      });
      const price = candidate.salePrices[0] !== undefined ? `$${candidate.salePrices[0]}` : '';
      const details = [price, `SKU ${candidate.sku}`, candidate.inStock ? '' : 'out of stock'].filter(Boolean).join(' · ');
      list.append(el('li', {}, el('span', { textContent: candidate.title }), el('span', { className: 'muted', textContent: details }), add));
    }
    wrap.append(list);
  }
  return wrap;
}

function inStoreToggle(hotspot: Hotspot) {
  const box = el('input', { type: 'checkbox', checked: !!hotspot.inStoreOnly, disabled: deps.readOnly() }) as HTMLInputElement;
  box.addEventListener('change', () => {
    hotspot.inStoreOnly = box.checked;
    changed(hotspot);
  });
  return el('label', { className: 'check' }, box, el('span', { textContent: 'In store only (no online link)' }));
}

function renderInspector() {
  const panel = $('edInspector');
  panel.replaceChildren();
  const hotspot = selectedHotspot();
  if (!hotspot) {
    const list = hotspots();
    panel.append(
      el('h3', { textContent: `Page ${state.page + 1}` }),
      el('p', {
        className: 'muted',
        textContent: list.length
          ? 'Pick a hotspot to edit it, here or on the page. Drag a box to move it, drag its corner to resize it.'
          : 'No hotspots on this page. Use Draw box to add one.',
      }),
    );
    if (list.length) {
      panel.append(
        el(
          'ul',
          { className: 'hslist' },
          ...list.map((h, i) => {
            const pick = el(
              'button',
              { type: 'button' },
              el('span', { className: 'num', textContent: String(i + 1) }),
              el('span', { className: 'name', textContent: h.label || 'Unnamed' }),
              ...(hasProduct(h) ? [] : [el('span', { className: 'chip review', textContent: 'No product' })]),
            );
            pick.addEventListener('click', () => select(i));
            pick.dataset.idx = String(i);
            return el('li', {}, pick);
          }),
        ),
      );
    }
    return;
  }
  const ro = deps.readOnly();
  const text = (value: string, onInput: (v: string) => void) => {
    const input = el('input', { type: 'text', value, disabled: ro }) as HTMLInputElement;
    input.addEventListener('input', () => {
      onInput(input.value);
      changed(hotspot);
    });
    return input;
  };
  const fallbackType = el(
    'select',
    { disabled: ro },
    ...(['search', 'brand', 'category'] as const).map((t) =>
      el('option', { value: t, textContent: t[0].toUpperCase() + t.slice(1), selected: hotspot.fallback.type === t }),
    ),
  ) as HTMLSelectElement;
  fallbackType.addEventListener('change', () => {
    hotspot.fallback.type = fallbackType.value as Hotspot['fallback']['type'];
    changed(hotspot);
  });

  const back = el('button', { type: 'button', className: 'link back', textContent: '‹ All hotspots on this page' });
  back.addEventListener('click', () => select(-1));
  const details = el('div', { className: 'group' });
  details.append(
    el('h4', { textContent: 'Details' }),
    field('Product name', text(hotspot.label, (v) => (hotspot.label = v))),
    field('Price as printed', text(hotspot.priceText, (v) => (hotspot.priceText = v))),
    el(
      'div',
      { className: 'row' },
      field('Link when no product', fallbackType),
      field('Value', text(hotspot.fallback.value, (v) => (hotspot.fallback.value = v))),
    ),
    inStoreToggle(hotspot),
  );
  const products = el('div', { className: 'group' }, el('h4', { textContent: 'Products' }));
  if (hotspot.skus.length) {
    products.append(el('ul', { className: 'linked' }, ...hotspot.skus.map((_, i) => productRow(hotspot, i))));
    loadProductNames(hotspot.objectIds ?? []);
  } else {
    products.append(el('p', { className: 'warn', textContent: 'No product: this hotspot uses its fallback link.' }));
  }
  products.append(renderSearch(hotspot));
  panel.append(back, el('h3', { textContent: `Hotspot ${state.selected + 1}` }), details, products);

  const del = el('button', {
    type: 'button',
    className: 'danger',
    textContent: state.confirmDelete ? 'Click again to delete' : 'Delete hotspot',
    disabled: ro,
  });
  del.addEventListener('click', () => {
    if (!state.confirmDelete) {
      state.confirmDelete = true;
      renderInspector();
      return;
    }
    hotspots().splice(state.selected, 1);
    select(-1);
    changed();
  });
  panel.append(el('div', { className: 'group' }, del));
}

function render() {
  renderPageControls();
  renderSheet();
  renderInspector();
}

function select(index: number) {
  if (index !== state.selected) {
    state.searchResults = [];
    state.searchQuery = '';
  }
  state.selected = index;
  state.confirmDelete = false;
  render();
}

function goTo(page: number) {
  state.page = clamp(page, 0, state.pages.length - 1);
  state.drawing = false;
  select(-1);
}

// ---------- pointer editing ----------

type Drag =
  | { mode: 'draw'; start: { x: number; y: number }; draft: HTMLElement }
  | { mode: 'move' | 'resize'; idx: number; start: { x: number; y: number }; orig: Hotspot['box']; moved: boolean };
let drag: Drag | null = null;

function pointInSheet(ev: PointerEvent) {
  const rect = $('edSheet').getBoundingClientRect();
  return { x: ((ev.clientX - rect.left) / rect.width) * 100, y: ((ev.clientY - rect.top) / rect.height) * 100 };
}

function wirePointer() {
  const sheet = $('edSheet');
  sheet.addEventListener('pointerdown', (ev) => {
    if (deps.readOnly() || !state.pages[state.page]?.image) return;
    const target = ev.target as HTMLElement;
    const boxEl = target.closest<HTMLElement>('.hs');
    const pt = pointInSheet(ev);
    if (state.drawing && !boxEl) {
      const draft = el('div', { className: 'draft' });
      sheet.append(draft);
      drag = { mode: 'draw', start: pt, draft };
    } else if (boxEl) {
      const idx = Number(boxEl.dataset.idx);
      if (idx !== state.selected) select(idx);
      drag = { mode: target.classList.contains('grip') ? 'resize' : 'move', idx, start: pt, orig: { ...hotspots()[idx].box }, moved: false };
    } else {
      select(-1);
      return;
    }
    sheet.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  sheet.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const pt = pointInSheet(ev);
    const dx = pt.x - drag.start.x;
    const dy = pt.y - drag.start.y;
    if (drag.mode === 'draw') {
      Object.assign(drag.draft.style, {
        left: `${Math.min(pt.x, drag.start.x)}%`,
        top: `${Math.min(pt.y, drag.start.y)}%`,
        width: `${Math.abs(dx)}%`,
        height: `${Math.abs(dy)}%`,
      });
      return;
    }
    if (Math.abs(dx) + Math.abs(dy) > 0.3) drag.moved = true;
    const box = hotspots()[drag.idx].box;
    const o = drag.orig;
    if (drag.mode === 'move') {
      box.x = round1(clamp(o.x + dx, 0, 100 - o.w));
      box.y = round1(clamp(o.y + dy, 0, 100 - o.h));
    } else {
      box.w = round1(clamp(o.w + dx, 1, 100 - o.x));
      box.h = round1(clamp(o.h + dy, 1, 100 - o.y));
    }
    const boxEl = sheet.querySelector<HTMLElement>(`.hs[data-idx="${drag.idx}"]`);
    if (boxEl) Object.assign(boxEl.style, { left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` });
  });

  sheet.addEventListener('pointerup', (ev) => {
    if (!drag) return;
    const current = drag;
    drag = null;
    if (current.mode === 'draw') {
      current.draft.remove();
      const pt = pointInSheet(ev);
      const x = clamp(Math.min(pt.x, current.start.x), 0, 100);
      const y = clamp(Math.min(pt.y, current.start.y), 0, 100);
      const w = Math.abs(pt.x - current.start.x);
      const h = Math.abs(pt.y - current.start.y);
      if (w > 2 && h > 2) {
        const hotspot: Hotspot = {
          label: '',
          priceText: '',
          box: { x: round1(x), y: round1(y), w: round1(clamp(w, 1, 100 - x)), h: round1(clamp(h, 1, 100 - y)) },
          skus: [],
          objectIds: [],
          fallback: { type: 'search', value: '' },
          locked: true,
          confidence: 'high',
        };
        hotspots().push(hotspot);
        state.drawing = false;
        changed(hotspot);
        select(hotspots().length - 1);
      }
      return;
    }
    if (current.moved) changed(hotspots()[current.idx]);
    render();
  });

  sheet.addEventListener('keydown', (ev) => {
    const boxEl = (ev.target as HTMLElement).closest<HTMLElement>('.hs');
    if (!boxEl || deps.readOnly()) return;
    const step = ({ ArrowLeft: [-0.5, 0], ArrowRight: [0.5, 0], ArrowUp: [0, -0.5], ArrowDown: [0, 0.5] } as Record<string, number[]>)[ev.key];
    if (!step) return;
    ev.preventDefault();
    const idx = Number(boxEl.dataset.idx);
    const box = hotspots()[idx].box;
    if (ev.shiftKey) {
      box.w = round1(clamp(box.w + step[0], 1, 100 - box.x));
      box.h = round1(clamp(box.h + step[1], 1, 100 - box.y));
    } else {
      box.x = round1(clamp(box.x + step[0], 0, 100 - box.w));
      box.y = round1(clamp(box.y + step[1], 0, 100 - box.h));
    }
    changed(hotspots()[idx]);
    select(idx);
    $('edSheet').querySelector<HTMLElement>(`.hs[data-idx="${idx}"]`)?.focus();
  });

  sheet.addEventListener('click', (ev) => {
    // Keyboard activation (Enter/Space) of a box button selects it; pointer selection happens on pointerdown.
    const boxEl = (ev.target as HTMLElement).closest<HTMLElement>('.hs');
    if (boxEl && (ev as MouseEvent).detail === 0) select(Number(boxEl.dataset.idx));
  });
}

// Hovering or focusing a hotspot in the side list outlines its box on the page, and the other way round.
function hint(idx: string | undefined) {
  document.querySelectorAll('.hs.hint, ul.hslist button.hint').forEach((node) => node.classList.remove('hint'));
  if (idx === undefined) return;
  document.querySelectorAll(`.hs[data-idx="${idx}"], ul.hslist button[data-idx="${idx}"]`).forEach((node) => node.classList.add('hint'));
}

function wireHints() {
  for (const container of [$('edSheet'), $('edInspector')]) {
    const target = (ev: Event) => (ev.target as HTMLElement).closest<HTMLElement>('.hs, ul.hslist button')?.dataset.idx;
    container.addEventListener('pointerover', (ev) => hint(target(ev)));
    container.addEventListener('pointerleave', () => hint(undefined));
    container.addEventListener('focusin', (ev) => hint(target(ev)));
    container.addEventListener('focusout', () => hint(undefined));
  }
}

let wired = false;

/** Shows the editor for `pages` (the field's current value). */
export function openEditor(pages: FlyerPage[], editorDeps: EditorDeps) {
  deps = editorDeps;
  state.pages = structuredClone(pages).map((page) => ({
    ...page,
    hotspots: (page.hotspots ?? []).map((h) => ({ ...h, skus: h.skus ?? [], objectIds: h.objectIds ?? [] })),
  }));
  state.page = clamp(state.page, 0, Math.max(0, state.pages.length - 1));
  state.selected = -1;
  $('editor').hidden = !state.pages.length;
  if (!wired) {
    wired = true;
    wirePointer();
    wireHints();
    $('edPrev').addEventListener('click', () => goTo(state.page - 1));
    $('edNext').addEventListener('click', () => goTo(state.page + 1));
    ($('edPageSelect') as HTMLSelectElement).addEventListener('change', (e) => goTo(Number((e.target as HTMLSelectElement).value)));
    $('edDraw').addEventListener('click', () => {
      state.drawing = !state.drawing;
      render();
    });
  }
  setStatus('');
  render();
}

export function refreshEditor() {
  if (state.pages.length) render();
}
