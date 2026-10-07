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
3. In the Digital Flyer item, choose the `.json`. The importer searches Scheels Search (ACE, `search.scheels.com`) for every hotspot and ticks products whose brand, model name and printed price agree; check the rest ("Show only ones to check"). Then import. Each page finds its published image by name (`flyer-<campaign>-pNN`) and takes the asset id from the media server. Pages whose image is not published yet are imported without one and hidden on the site; publish them and import again. Fill in title, campaign and dates as shown, then save.

Installation parameters: `studioUrl` (the Flyer Studio share link, including its `?sk=` key; kept here rather than in the code because the hosted extension is public), and optionally `endpoint` (default `scheelspoc`) and `defaultHost` (default `cdn.media.amplience.net`).

Once an item has pages, the extension opens on the **saved flyer**: each page image with its hotspots, where boxes can be moved, resized, drawn or deleted, and a hotspot's name, price, fallback link and products changed (products are found through Scheels Search). Changes go into the field; save the item to keep them. The import steps fold away under "Replace with a new Flyer Studio export".

The extension writes only the `pages` field; Amplience field extensions cannot set other fields, so it shows those values to copy and flags any that differ from the item.
