# Draw real handler cards (outputs/developer-labs/previews.json) as labelled synthetic previews.
import json, os, textwrap
from PIL import Image, ImageDraw, ImageFont
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
def font(size, bold=False):
    for name in (['segoeuib.ttf', 'DejaVuSans-Bold.ttf'] if bold else ['segoeui.ttf', 'DejaVuSans.ttf']):
        try: return ImageFont.truetype(name, size)
        except OSError: pass
    return ImageFont.load_default()
for card in json.load(open(os.path.join(root, 'outputs/developer-labs/previews.json'), encoding='utf8')):
    img = Image.new('RGB', (1280, 800), (244, 246, 250)); d = ImageDraw.Draw(img)
    d.rounded_rectangle((120, 120, 1160, 680), 24, fill=(255, 255, 255), outline=(208, 214, 224), width=2)
    d.text((170, 170), card['title'], font=font(44, True), fill=(24, 32, 48)); y = 260
    for line in card['lines']:
        for part in textwrap.wrap(line, 52):
            d.text((170, y), part, font=font(32), fill=(48, 60, 80)); y += 48
        y += 16
    for k, v in card.get('facts', {}).items():
        d.text((170, y), f'{k}: {v}', font=font(26), fill=(90, 100, 120)); y += 38
    d.text((170, 620), 'Synthetic preview of a real handler card on a bundled fixture', font=font(22), fill=(120, 128, 140))
    path = os.path.join(root, 'store/plugins', card['id'], 'shots'); os.makedirs(path, exist_ok=True)
    img.save(os.path.join(path, '1.png'), optimize=True); print(card['id'])
