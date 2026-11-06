// Transparent stdio recorder; forwards real upstream bytes, never creates responses.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const out=resolve(process.env.PUBLIC_MCP_EVIDENCE);
const exe=resolve(process.env.PUBLIC_MCP_BINARY);
const child=spawn(exe,['stdio','--tools=search_provider_docs,get_provider_details','--log-level=debug'],{stdio:['pipe','pipe','pipe'],env:{SYSTEMROOT:process.env.SYSTEMROOT,PATH:process.env.PATH,HOME:process.cwd(),USERPROFILE:process.cwd(),APPDATA:process.cwd(),LOCALAPPDATA:process.cwd(),TEMP:process.env.TEMP,TMP:process.env.TMP,OTEL_METRICS_ENABLED:'false',TF_X_OFFICIAL_SDK_ENABLED:'false'}});
writeFileSync(out+'.identity.json',JSON.stringify({launcherPid:process.pid,upstreamPid:child.pid,exe,started:new Date().toISOString()}));
process.stdin.pipe(child.stdin);child.stdout.on('data',d=>{appendFileSync(out+'.protocol.ndjson',d);process.stdout.write(d)});child.stderr.on('data',d=>{appendFileSync(out+'.stderr.log',d);process.stderr.write(d)});
const stop=()=>{child.stdin.end();child.kill();};process.on('SIGTERM',stop);process.on('SIGINT',stop);process.stdin.on('end',stop);child.on('exit',code=>process.exit(code??0));
