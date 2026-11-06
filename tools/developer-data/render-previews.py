"""Render clearly labelled synthetic card previews from actual handler output."""
from pathlib import Path
import json, textwrap
from PIL import Image, ImageDraw, ImageFont
root=Path(__file__).resolve().parents[2]
data=json.loads((root/'outputs/developer-addons/data/previews.json').read_text())
font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',23)
title=ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf',32)
for item in data:
    image=Image.new('RGB',(1100,650),'#101c2c');d=ImageDraw.Draw(image)
    d.text((42,32),'SYNTHETIC PREVIEW — actual offline handler output',font=font,fill='#72dbc4')
    d.text((42,95),item['title'],font=title,fill='white')
    y=160
    lines=item['lines']+(['Seed: '+str(item['report']['seed']), 'Tables: parent (3 rows), child (5 rows)', 'SQLite SQL + structured synthetic fixtures'] if 'seed' in item['report'] else ['Compatible: '+str(item['report']['compatible']), 'Breaking: '+', '.join(item['report']['breaking']), 'Payload validity: '+str([p['valid'] for p in item['report']['payloads']])])
    for line in lines:
        for wrapped in textwrap.wrap(line,77):
            d.text((42,y),wrapped,font=font,fill='#d7e3ed');y+=37
        y+=12
    d.text((42,592),'No live database, workspace, account or model access.',font=font,fill='#72dbc4')
    target=root/'store/plugins'/item['id']/'shots/1.png';target.parent.mkdir(parents=True,exist_ok=True);image.save(target)
