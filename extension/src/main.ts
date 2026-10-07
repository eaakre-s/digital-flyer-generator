import { init } from 'dc-extensions-sdk';
import type { ContentFieldExtension } from 'dc-extensions-sdk';
import { devSdk } from './dev-sdk';
import { buildPages, findImage, parseStudioExport, type FlyerPage, type ImageLink, type MediaSettings, type StudioFlyer } from './flyer';
import { openEditor, refreshEditor } from './editor';
import { countByStatus, matchProducts, renderProducts, withChosenSkus, type Matches } from './products';

type Sdk = Pick<ContentFieldExtension<FlyerPage[]>, 'field' | 'form' | 'frame' | 'params'>;
type ImageStatus = 'checking' | 'published' | 'missing';

// Scheels' Amplience media account. Installation parameters `endpoint` / `defaultHost` override it.
const DEFAULT_MEDIA: MediaSettings = { endpoint: 'scheelspoc', defaultHost: 'cdn.media.amplience.net' };
const CHECKS_AT_ONCE = 6;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const state: {
  flyer: StudioFlyer | null;
  status: ImageStatus[];
  images: (ImageLink | null)[];
  matches: Matches | null;
  matching: boolean;
  reviewOnly: boolean;
  readOnly: boolean;
  run: number;
} = {
  flyer: null,
  status: [],
  images: [],
  matches: null,
  matching: false,
  reviewOnly: true,
  readOnly: false,
  run: 0,
};
let sdk: Sdk;
let media = DEFAULT_MEDIA;

function setMessage(text: string, kind: 'info' | 'error' | 'ok' = 'info') {
  const el = $('message');
  el.textContent = text;
  el.dataset.kind = kind;
}

/** Opens the saved flyer in the editor; the import steps fold away once the item has pages. */
async function showCurrent() {
  const pages = (await sdk.field.getValue()) ?? [];
  const hotspots = pages.reduce((n, page) => n + (page.hotspots?.length ?? 0), 0);
  $('current').textContent = pages.length
    ? `This item has ${pages.length} pages and ${hotspots} hotspots. Importing replaces them.`
    : 'This item has no pages yet.';
  ($('importer') as HTMLDetailsElement).open = !pages.length;
  $('importerSummary').textContent = pages.length ? 'Replace with a new Flyer Studio export' : 'Import from Flyer Studio';
  openEditor(pages, { write: writePages, readOnly: () => state.readOnly, resize: () => sdk.frame.setHeight() });
}

async function writePages(pages: FlyerPage[]): Promise<string | null> {
  try {
    const errors = await sdk.field.setValue(pages);
    return Array.isArray(errors) && errors.length ? `Amplience rejected the change: ${errors.map((e) => e.message).join('; ')}` : null;
  } catch (error) {
    return `The change could not be written: ${(error as Error).message}`;
  }
}

async function showDetails(flyer: StudioFlyer) {
  const form = ((await sdk.form.getValue().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const rows: [string, string, string][] = [
    ['Title', 'title', flyer.title],
    ['Campaign code', 'campaign', flyer.campaign],
    ['Sale starts', 'startDate', flyer.startDate],
    ['Sale ends', 'endDate', flyer.endDate],
  ];
  const list = $('details');
  list.replaceChildren();
  for (const [label, key, value] of rows) {
    if (!value) continue;
    const matches = String(form[key] ?? '') === value;
    const row = document.createElement('li');
    const name = Object.assign(document.createElement('span'), { className: 'label', textContent: label });
    const val = Object.assign(document.createElement('code'), { textContent: value });
    const note = Object.assign(document.createElement('span'), {
      className: matches ? 'ok' : 'warn',
      textContent: matches ? 'matches this item' : 'copy into the field above',
    });
    row.append(name, val, note);
    if (!matches) {
      const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: 'Copy' });
      copy.addEventListener('click', () =>
        navigator.clipboard?.writeText(value).then(
          () => (copy.textContent = 'Copied'),
          () => (copy.textContent = 'Select and copy it'),
        ),
      );
      row.append(copy);
    }
    list.append(row);
  }
}

const STATUS_TEXT: Record<ImageStatus, string> = {
  checking: 'Checking…',
  published: 'Published',
  missing: 'Not published yet',
};

function renderPages() {
  const flyer = state.flyer;
  const table = $('pages');
  table.replaceChildren();
  $('stepProducts').hidden = !flyer;
  $('step2').hidden = !flyer;
  $('step3').hidden = !flyer;
  if (!flyer) return;

  flyer.pages.forEach((page, i) => {
    const status = state.status[i] ?? 'checking';
    const row = document.createElement('tr');
    [String(i + 1), page.imageName, String(page.hotspots.length), STATUS_TEXT[status]].forEach((text, c) => {
      const td = Object.assign(document.createElement('td'), { textContent: text });
      if (c === 3) td.className = status === 'published' ? 'ok' : status === 'missing' ? 'warn' : 'muted';
      row.append(td);
    });
    table.append(row);
  });

  const checking = state.status.filter((s) => s === 'checking').length;
  const missing = state.status.filter((s) => s === 'missing').length;
  $('imageSummary').textContent = checking
    ? `Checking ${flyer.pages.length} page images…`
    : missing
      ? `${missing} of ${flyer.pages.length} images are not published yet. You can import now; those pages stay hidden on the site until you publish their images and import again.`
      : `All ${flyer.pages.length} page images are published.`;
  ($('applyBtn') as HTMLButtonElement).disabled = state.readOnly || checking > 0 || state.matching;
  ($('recheckBtn') as HTMLButtonElement).disabled = checking > 0;
}

async function checkImages() {
  const flyer = state.flyer;
  if (!flyer) return;
  const run = ++state.run;
  state.status = flyer.pages.map(() => 'checking');
  state.images = flyer.pages.map(() => null);
  renderPages();
  let next = 0;
  const worker = async () => {
    while (next < flyer.pages.length) {
      const i = next++;
      const image = await findImage(flyer.pages[i].imageName, media);
      if (run !== state.run) return;
      state.images[i] = image;
      state.status[i] = image ? 'published' : 'missing';
      renderPages();
    }
  };
  await Promise.all(Array.from({ length: CHECKS_AT_ONCE }, worker));
}

function renderMatches() {
  const flyer = state.flyer;
  if (!flyer) return;
  const summary = $('productSummary');
  const toggle = $('reviewToggle') as HTMLButtonElement;
  if (!state.matches) {
    $('productList').replaceChildren();
    toggle.hidden = true;
    return;
  }
  const counts = countByStatus(state.matches);
  summary.textContent = [
    `${counts.matched} matched automatically`,
    counts.kept ? `${counts.kept} kept from Flyer Studio` : '',
    `${counts.review} to check${counts.unresolved ? ` (${counts.unresolved} with nothing ticked)` : ''}`,
    `${counts.none} not found`,
  ]
    .filter(Boolean)
    .join(' · ');
  toggle.hidden = false;
  toggle.textContent = state.reviewOnly ? 'Show all products' : 'Show only ones to check';
  renderProducts($('productList'), flyer, state.matches, {
    reviewOnly: state.reviewOnly,
    readOnly: state.readOnly,
    onChange: renderMatches,
  });
}

async function findProducts() {
  const flyer = state.flyer;
  if (!flyer) return;
  const run = state.run;
  state.matching = true;
  state.matches = null;
  renderMatches();
  renderPages();
  try {
    const matches = await matchProducts(flyer, (done, total) => {
      $('productSummary').textContent = `Searching Scheels for ${done} of ${total} products…`;
    });
    if (run !== state.run || flyer !== state.flyer) return;
    state.matches = matches;
  } catch (error) {
    $('productSummary').textContent = `Scheels Search could not be reached (${(error as Error).message}). You can still import; hotspots keep any SKUs from Flyer Studio.`;
  } finally {
    state.matching = false;
    renderMatches();
    renderPages();
  }
}

async function chooseFile(file: File) {
  try {
    state.flyer = parseStudioExport(await file.text());
    const hotspots = state.flyer.pages.reduce((n, page) => n + page.hotspots.length, 0);
    setMessage(`Read ${file.name}: ${state.flyer.pages.length} pages, ${hotspots} hotspots.`, 'ok');
    await showDetails(state.flyer);
  } catch (error) {
    state.flyer = null;
    setMessage((error as Error).message, 'error');
  }
  renderPages();
  checkImages();
  findProducts();
}

async function apply() {
  if (!state.flyer) return;
  try {
    const flyer = state.matches ? withChosenSkus(state.flyer, state.matches) : state.flyer;
    const errors = await sdk.field.setValue(buildPages(flyer, state.images));
    if (Array.isArray(errors) && errors.length) {
      setMessage(`Amplience rejected the pages: ${errors.map((e) => e.message).join('; ')}`, 'error');
      return;
    }
    const missing = state.images.filter((image) => !image).length;
    setMessage(
      missing
        ? `Imported ${state.flyer.pages.length} pages; ${missing} without an image yet. Save the item to keep them.`
        : `Imported ${state.flyer.pages.length} pages. Save the item to keep them.`,
      'ok',
    );
    await showCurrent();
  } catch (error) {
    setMessage(`The pages could not be imported: ${(error as Error).message}`, 'error');
  }
}

function setReadOnly(readOnly: boolean) {
  state.readOnly = readOnly;
  ($('fileInput') as HTMLInputElement).disabled = readOnly;
  renderPages();
  renderMatches();
  refreshEditor();
}

async function start() {
  const framed = window.parent !== window;
  sdk = framed ? await init<ContentFieldExtension<FlyerPage[]>>() : (devSdk() as unknown as Sdk);
  const installation = (sdk.params?.installation ?? {}) as Partial<MediaSettings> & { studioUrl?: string };
  if (installation.studioUrl) ($('studioLink') as HTMLAnchorElement).href = installation.studioUrl;
  media = {
    endpoint: installation.endpoint || DEFAULT_MEDIA.endpoint,
    defaultHost: installation.defaultHost || DEFAULT_MEDIA.defaultHost,
  };
  sdk.frame.startAutoResizer();
  setReadOnly(sdk.form.readOnly);
  sdk.form.onReadOnlyChange(setReadOnly);
  if (!framed) setMessage('Running outside Amplience, for local testing.');

  $('fileInput').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) chooseFile(file);
  });
  $('recheckBtn').addEventListener('click', checkImages);
  $('reviewToggle').addEventListener('click', () => {
    state.reviewOnly = !state.reviewOnly;
    renderMatches();
  });
  $('applyBtn').addEventListener('click', apply);
  await showCurrent();
}

start().catch(() => setMessage('The importer could not connect to Amplience. Reload the content item.', 'error'));
