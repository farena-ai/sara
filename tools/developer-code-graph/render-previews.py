"""Actual result preview, not a Sara UI screenshot or fabricated execution."""
from pathlib import Path
import json, textwrap
from PIL import Image, ImageDraw, ImageFont
root=Path(__file__).resolve().parents[2]
font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',22)
title=ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf',32)
for item in json.loads((root/'outputs/developer-addons/code-graph/previews.json').read_text(encoding='utf8')):
    r=item['report']
    image=Image.new('RGB',(1200,760),'#101c2c');d=ImageDraw.Draw(image)
    d.text((40,28),'SYNTHETIC RESULT PREVIEW — actual offline AST analysis',font=font,fill='#72dbc4')
    d.text((40,85),item['title'],font=title,fill='white')
    lines=item['lines']
    if 'callers' in r:
        lines+=['Changed: '+', '.join(x['symbol'] for x in r['changed']), 'Callers: '+', '.join(x['symbol'] for x in r['callers']), 'Packages: '+', '.join(r['packages']), 'Supplied test candidate: '+', '.join(r['tests'])]
    else:
        lines+=['Direction: '+r['direction'], 'Findings: '+', '.join(x['code'] for x in r['findings']), 'Cycle: '+' -> '.join(r['cycles'][0]['paths']), 'Policy satisfied: '+str(r['policySatisfied'])]
    y=155
    for line in lines:
        for wrapped in textwrap.wrap(line,88):
            d.text((40,y),wrapped,font=font,fill='#d7e3ed');y+=34
        y+=10
    d.text((40,710),'Explicit synthetic source only. No project/test execution, network or model.',font=font,fill='#72dbc4')
    target=root/'store/plugins'/item['id']/'shots/1.png';target.parent.mkdir(parents=True,exist_ok=True);image.save(target)
