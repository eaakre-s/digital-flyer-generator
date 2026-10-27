"""Builds flyer-studio.html (the published Flyer Studio artifact) from template.html and the example page.

    python3 studio/build.py
Then publish studio/flyer-studio.html to https://claude.ai/artifact/LZKiFFQj8WEiLuP8osgyRH with
capabilities {"sample": {"images": true}, "downloads": true,
"mcp": {"servers": [{"server": "Claude IBMi Developer Tools", "tools": ["execute_sql"]}]},
"db": {}, "room": {}, "assets": {}, "user": {"scopes": ["profile"]}}.

Categories for the link editor come from data/categories.csv (the importer extension reads the same
file). The Link & Value Generator's address comes from studio/local.json ({"linkGeneratorUrl": "..."}),
which is git-ignored because this repository is public; without it the link is left out.
"""
import csv
import json
import re
from pathlib import Path

here = Path(__file__).parent
hotspots = json.loads((here / 'example-p26.hotspots.json').read_text())['hotspots']
for h in hotspots:
    brand = h.get('brand', '')
    rest = re.sub('^' + re.escape(brand) + r'\s*', '', h['label'], flags=re.I)
    h['fallback'] = {'searchTerm': (brand + ' ' + rest).strip()}
    h['locked'] = False
page = (here / 'template.html').read_text()
page = page.replace('__EXAMPLE_IMG__', (here / 'example-p26.datauri').read_text().strip())
page = page.replace('__EXAMPLE_HOTSPOTS__', json.dumps(hotspots))
with open(here.parent / 'data' / 'categories.csv', encoding='utf-8-sig', newline='') as f:
    categories = [[r['display_name'].strip(), r['slug'].strip()] for r in csv.DictReader(f) if r.get('display_name') and r.get('slug')]
# Escaped so no name can close the page's script element.
page = page.replace('__CATEGORIES__', json.dumps(categories, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/'))
local = here / 'local.json'
generator = json.loads(local.read_text()).get('linkGeneratorUrl', '') if local.exists() else ''
page = page.replace('__LINK_GENERATOR_URL__', json.dumps(generator))
(here / 'flyer-studio.html').write_text(page)
print('wrote', here / 'flyer-studio.html')
