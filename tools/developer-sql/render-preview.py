"""Render a clearly labelled preview from actual SQLite rehearsal output."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
root=Path(__file__).resolve().parents[2]
p=json.loads((root/'outputs/developer-addons/sql/preview.json').read_text())
safe=json.loads(p['safe']['content']); unsafe=json.loads(p['unsafe']['content'])
im=Image.new('RGB',(1100,650),'#101826');d=ImageDraw.Draw(im)
font=ImageFont.truetype('C:/Windows/Fonts/consola.ttf',24)
lines=['SQL Migration Reviewer','SYNTHETIC PREVIEW - actual handler output, not Sara UI','',f"Safe: {safe['status']} | SQLite authorizer: {safe['authorizerEnforced']}",f"Statements executed: {safe['executedStatements']}",f"Tables before/after: {len(safe['before']['tables'])}/{len(safe['after']['tables'])}",f"Data preserved: {safe['dataPreserved']}",f"Rollback verified: {safe['rollbackVerified']} | Closed: {safe['closed']}",'',f"Unsafe DROP: {unsafe['status']}",f"Statements executed: {unsafe['executedStatements']}",'','Disposable :memory: only. No live database or project access.']
for i,line in enumerate(lines):d.text((36,32+i*43),line,font=font,fill='#9de9cf' if i in [0,3,9] else '#e0e7f0')
out=root/'store/plugins/sql-migration-reviewer/shots';out.mkdir(parents=True,exist_ok=True);im.save(out/'1.png')
