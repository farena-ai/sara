from pathlib import Path
import json
from PIL import Image,ImageDraw,ImageFont
root=Path(__file__).resolve().parents[2]
report=json.loads(json.loads((root/'outputs/developer-addons/visual-regression/preview-result.json').read_text())['content'])
shots=root/'store/plugins/visual-regression/shots';shots.mkdir(exist_ok=True)
font='C:/Windows/Fonts/segoeui.ttf'
for width,height,name in [(1100,680,'desktop'),(390,760,'phone')]:
 im=Image.new('RGB',(width,height),'#101827');d=ImageDraw.Draw(im)
 f=ImageFont.truetype(font,22 if width>400 else 17);h=ImageFont.truetype(font,32 if width>400 else 25)
 d.text((24,25),'Visual Regression',font=h,fill='#ffffff');d.text((24,80),'Synthetic result preview',font=f,fill='#ffcc66')
 y=130
 for p in report['pairs']:
  for line in [p['viewport'],f"{p['width']} x {p['height']}",f"Changed pixels: {p['changedPixels']}",'Rectangle: 32, 96, 40, 24']:
   d.text((24,y),line,font=f,fill='#c8d8ed');y+=34
  y+=24
 for line in ['Actual offline handler result.','No source pixels displayed.','Not a Sara app screenshot.']:
  d.text((24,y+20),line,font=f,fill='#80ceb9');y+=34
 im.save(shots/(name+'.png'))
 print(name,im.size)
