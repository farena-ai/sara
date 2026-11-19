# Rebuilds src/photo-places.ts (V4.1 offline place names). Download cities15000.zip and countryInfo.txt
# from https://download.geonames.org/export/dump/ (free, CC BY 4.0, no sign-up) into one folder, then:
#   python scripts/photo-places.py <that folder>
import zipfile, json, sys, os
S = sys.argv[1].rstrip('/\\') + '/'
countries = {}
for line in open(S + 'countryInfo.txt', encoding='utf-8'):
    if line.startswith('#'): continue
    f = line.rstrip('\n').split('\t')
    if len(f) > 4: countries[f[0]] = f[4]
rows = []
with zipfile.ZipFile(S + 'cities15000.zip') as z:
    for line in z.open('cities15000.txt').read().decode('utf-8').splitlines():
        f = line.split('\t')
        pop = int(f[14] or 0)
        if pop < 100000 and f[7] != 'PPLC': continue
        rows.append([f[2] or f[1], f[8], round(float(f[4]), 3), round(float(f[5]), 3)])
rows.sort(key=lambda r: (r[1], r[0]))
head = ('// V4.1: offline place names for photo GPS (no lookup ever leaves the computer). Generated from\n'
        '// GeoNames cities15000 (https://www.geonames.org, CC BY 4.0): cities of 100,000+ people and capitals.\n'
        '// Rows are name, country code, latitude, longitude. Rebuild: scripts/photo-places.py.\n')
body = 'export const COUNTRIES: Record<string, string> = ' + json.dumps(countries, ensure_ascii=False, sort_keys=True) + ';\n'
body += 'export const CITIES: readonly (readonly [string, string, number, number])[] = [\n' + ''.join(json.dumps(r, ensure_ascii=False) + ',\n' for r in rows) + '];\n'
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'photo-places.ts'), 'w', encoding='utf-8', newline='\n').write(head + body)
print(len(rows))
