"""Builds flyer-studio.html (the published Flyer Studio artifact) from template.html and the example page.

    python3 studio/build.py
Then publish studio/flyer-studio.html to https://claude.ai/artifact/LZKiFFQj8WEiLuP8osgyRH with
capabilities {"sample": {"images": true}, "downloads": true}.
"""
import json
import re
from pathlib import Path

here = Path(__file__).parent
hotspots = json.loads((here / 'example-p26.hotspots.json').read_text())['hotspots']
for h in hotspots:
    brand = h.get('brand', '')
    rest = re.sub('^' + re.escape(brand) + r'\s*', '', h['label'], flags=re.I)
    h['fallback'] = {'type': 'search', 'value': (brand + ' ' + rest).strip()}
    h['locked'] = False
page = (here / 'template.html').read_text()
page = page.replace('__EXAMPLE_IMG__', (here / 'example-p26.datauri').read_text().strip())
page = page.replace('__EXAMPLE_HOTSPOTS__', json.dumps(hotspots))
(here / 'flyer-studio.html').write_text(page)
print('wrote', here / 'flyer-studio.html')
