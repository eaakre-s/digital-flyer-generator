# digital-flyer-generator

Tools for turning a sale flyer PDF into a shoppable Digital Flyer on scheels.com. Design: [Shoppable Digital Flyer Pipeline](https://claude.ai/code/artifact/ef2f272f-7bf7-49c9-8b39-4d57dbbb00dd).

Pieces:

- **Flyer Studio** (a Claude artifact) drafts the hotspots and exports page images + flyer data.
- **`extension/`**: the Amplience importer extension (`flyer-import`) that loads that export into a Digital Flyer item.
- **`amplience/schemas/`**: the Digital Flyer content type.
- **`studio/`**: Flyer Studio's source. `npm run studio:build` writes `studio/flyer-studio.html`, which is published to the artifact.

## Importer extension

```bash
npm install
npm run extension:dev     # http://localhost:5175, with sample data when opened outside Amplience
npm run extension:build   # static files in dist/extension/
```

Host `dist/extension/` on any static host (GitHub Pages, Amplify), then in Amplience → Development → Extensions → Register:

| Setting | Value |
| --- | --- |
| Category | Content Field |
| Label | Flyer import |
| Name | `flyer-import` (the schema refers to this name) |
| URL | the hosted URL, or `http://localhost:5175` while developing |
| Initial height | 400 |
| Permissions | Sandbox: **Allow same origin** (otherwise the page's scripts are blocked from loading), **Allow pop-ups** and **Allow pop-ups to escape sandbox** (for the Flyer Studio link) |

The `pages` field of `digital-flyer.json` uses it via `"ui:extension": { "name": "flyer-import" }`. Register the extension before saving that schema, or the field shows an error.

How it is used, per flyer:

1. In Flyer Studio, save **images + flyer data (.zip)** and unzip it.
2. Upload the page images to ECOM Creative › Content Pages › Digital Flyers and publish them.
3. In the Digital Flyer item, choose the `.json`. The importer searches Scheels Search (ACE, `search.scheels.com`) for every hotspot and ticks products whose brand, model name and printed price agree, except on boxes edited by hand in Flyer Studio and left without products, where they are only suggested; check the rest ("Show only ones to check"). Hotspots Flyer Studio marks as covering a whole range (an item-list line with "All" in its Style column) are not searched and keep their link to the listing. Flyer Studio ticks **On sale only** on those that print a discount ("Save 25%", "20% off", a sale price beside the regular one), so their listing shows only products on sale; unticking it in Studio keeps the whole range. Brand names in links are changed to the spelling Scheels Search uses ("7Diamonds" → "7 Diamonds"), and brands it doesn't know are listed so they can be fixed by hand. A link that names a category, filter or search term is kept as Flyer Studio wrote it, since scheels.com uses them in that order; only an empty link gets the category and brand of the products found. Then import. Each page finds its published image by name (`flyer-<campaign>-pNN`) and takes the asset id from the media server. Pages whose image is not published yet are imported without one and hidden on the site; publish them and import again. Fill in title, campaign and dates as shown, then save.

Beans (`objectIds`) are checked against Scheels Search before the import. One it doesn't list is tried under the vendor number scheels.com uses (`repairBeans`): without leading zeros on the vendor number (`035886-1019399` is `35886-1019399`), or as the one product carrying that style code under another vendor number, accepted only when its brand is in the printed name, because unrelated products share short style codes. A bean still not listed is kept: scheels.com shows it once it is online and the hotspot's link until then. The review list shows each correction ("Bean corrected…") and each kept bean, and "Check flyer" in the saved-flyer editor lists beans not yet online.

Installation parameters: `studioUrl` (the Flyer Studio share link, including its `?sk=` key; kept here rather than in the code because the hosted extension is public), and optionally `endpoint` (default `scheelspoc`) and `defaultHost` (default `cdn.media.amplience.net`).

Once an item has pages, the extension opens on the **saved flyer**: each page image with its hotspots, where boxes can be moved, resized, drawn or deleted, and a hotspot's name, price, fallback link and products changed (products are found through Scheels Search). A hotspot can also have up to four **panel links**, each a label and a link, under an optional heading: like a shoppable image's links, scheels.com shows them at the bottom of the hotspot's product panel, under its products or under its button when it has none. Changes go into the field; save the item to keep them. Panel links, like other edits made here, reach Flyer Studio only through "Export for Flyer Studio" and loading that file into Studio, so do that before saving a new export from Studio and importing it. The import steps fold away under "Replace with a new Flyer Studio export".

The extension writes only the `pages` field; Amplience field extensions cannot set other fields, so it shows those values to copy and flags any that differ from the item.

### Flyers too big for one item

Amplience saves at most 200 KB in one content item, which a flyer with several hundred hotspots outgrows. Such a flyer continues in other Digital Flyer items linked under the first one's **More pages** (`parts`); scheels.com shows their pages after the flyer's own, in order, and ignores everything else in them (title, dates, lock). After a file is chosen, the importer estimates what the pages will take (`importedBytes`, budgeting 190,000 bytes per item to leave room for the item's other fields) and, when the flyer doesn't fit, suggests the fewest runs of about equal size (`splitPages`) and selects the first. Import that run into the flyer; for each other run, create a Digital Flyer, choose the same file, pick its run (or type the pages under **Import pages … to …**), import and save; then link those items under More pages on the flyer, in order. Publishing the flyer publishes the items it links.

Inside a part the saved-flyer editor numbers its pages from 1, and **Export for Flyer Studio** exports only that item's pages.
