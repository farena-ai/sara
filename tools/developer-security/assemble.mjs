// Reproducible package metadata/wrappers. Engines are maintained separately, never overwritten here.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
const root=join(dirname(fileURLToPath(import.meta.url)),'../..');
const langs=['en','es','fr','de','pt-BR','it'];
const titles=[['Secret scanner','Detector de secretos','Détecteur de secrets','Geheimnisprüfung','Detector de segredos','Rilevatore di segreti'],['License auditor','Auditor de licencias','Audit des licences','Lizenzprüfung','Auditor de licenças','Verifica delle licenze'],['SBOM builder','Generador SBOM','Générateur SBOM','SBOM-Erstellung','Gerador SBOM','Generatore SBOM'],['Artifact provenance verifier','Verificador de procedencia','Vérificateur de provenance','Artefakt-Herkunftsprüfung','Verificador de proveniência','Verifica provenienza artefatti']];
const descriptions=[
 ['Detect credential patterns in explicitly supplied text files; return locations and value-free finding IDs. No automatic disk scan.','Detecta patrones de credenciales en archivos de texto aportados; devuelve ubicaciones e identificadores sin valores. No examina el disco.','Détecte des motifs de secrets dans les textes fournis ; renvoie les emplacements et identifiants sans valeurs. Aucun parcours du disque.','Erkennt Zugangsdatenmuster in bereitgestellten Texten; liefert Fundorte und IDs ohne Werte. Kein automatischer Festplattenscan.','Detecta padrões de credenciais em textos fornecidos; retorna locais e IDs sem valores. Não varre o disco.','Rileva credenziali nei testi forniti; restituisce posizioni e ID senza valori. Nessuna scansione automatica del disco.'],
 ['Audit npm lockfile v2/v3 license metadata and SPDX expressions against an explicit allow/deny policy. Unknowns require review; not legal advice.','Revisa metadatos de licencias npm v2/v3 y expresiones SPDX según una política explícita. Los datos desconocidos requieren revisión; no es asesoría legal.','Examine les licences npm v2/v3 et expressions SPDX selon une politique explicite. Les inconnues nécessitent un examen ; aucun conseil juridique.','Prüft npm-v2/v3-Lizenzen und SPDX-Ausdrücke nach expliziter Richtlinie. Unbekanntes muss geprüft werden; keine Rechtsberatung.','Audita licenças npm v2/v3 e expressões SPDX conforme política explícita. Dados desconhecidos exigem revisão; não é orientação jurídica.','Verifica licenze npm v2/v3 ed espressioni SPDX con regole esplicite. I dati sconosciuti richiedono revisione; non è consulenza legale.'],
 ['Build a deterministic CycloneDX 1.5 npm inventory from supplied lockfile v2/v3, including nested identities, purls and SRI hashes. No dependency install.','Genera un inventario CycloneDX 1.5 desde un lockfile npm v2/v3 con identidades anidadas, purls y hashes SRI. No instala dependencias.','Crée un inventaire CycloneDX 1.5 depuis un lockfile npm v2/v3, avec identités imbriquées, purls et empreintes SRI. Aucune installation.','Erstellt CycloneDX-1.5-Inventar aus npm-v2/v3-Lockdateien mit verschachtelten Identitäten, PURLs und SRI-Hashes. Keine Installation.','Gera inventário CycloneDX 1.5 de lockfile npm v2/v3 com identidades aninhadas, purls e hashes SRI. Não instala dependências.','Genera un inventario CycloneDX 1.5 da lockfile npm v2/v3 con identità annidate, purl e hash SRI. Nessuna installazione.'],
 ['Verify supplied artifact bytes using SHA-256, Ed25519, a pinned public-key fingerprint and expected identity. Local envelope v1 only, not Sigstore/SLSA.','Verifica bytes con SHA-256, Ed25519, huella de clave fijada e identidad esperada. Solo sobre local v1; no Sigstore/SLSA.','Vérifie les octets avec SHA-256, Ed25519, empreinte de clé épinglée et identité attendue. Enveloppe locale v1 uniquement, pas Sigstore/SLSA.','Prüft Bytes mit SHA-256, Ed25519, festgelegtem Schlüsselfingerabdruck und erwarteter Identität. Nur lokales v1-Format, kein Sigstore/SLSA.','Verifica bytes com SHA-256, Ed25519, impressão de chave fixada e identidade esperada. Apenas envelope local v1, não Sigstore/SLSA.','Verifica byte con SHA-256, Ed25519, impronta della chiave fissata e identità attesa. Solo formato locale v1, non Sigstore/SLSA.']
];
const scopes=[
 ['Only supplied text inspected; pattern detection is not proof of absence. Finding IDs hash coordinates, never secret values.','Solo se examina el texto aportado; los patrones no prueban ausencia. Los IDs resumen coordenadas, nunca secretos.','Seuls les textes fournis sont examinés ; les motifs ne prouvent pas une absence. Les ID condensent les positions, jamais les secrets.','Nur bereitgestellte Texte geprüft; Muster beweisen keine Abwesenheit. IDs hashen Positionen, niemals Geheimnisse.','Somente textos fornecidos; padrões não provam ausência. IDs resumem coordenadas, nunca segredos.','Solo testi forniti; i modelli non provano assenza. Gli ID derivano dalle coordinate, mai dai segreti.'],
 ['Policy decisions only; metadata is unverified. Review unknown/custom licenses and legal obligations.','Solo decisiones de política; metadatos sin verificar. Revisa licencias desconocidas y obligaciones legales.','Décisions de politique uniquement ; métadonnées non vérifiées. Examinez les licences inconnues et obligations juridiques.','Nur Richtlinienentscheidungen; Metadaten ungeprüft. Unbekannte Lizenzen und Rechtspflichten prüfen.','Apenas decisões da política; metadados não verificados. Revise licenças desconhecidas e obrigações legais.','Solo decisioni delle regole; metadati non verificati. Rivedere licenze sconosciute e obblighi legali.'],
 ['Installed-path inventory only, not a complete dependency graph; supplied integrity is not a downloaded-file verification.','Solo inventario de rutas instaladas, no grafo completo; la integridad aportada no verifica archivos descargados.','Inventaire des chemins installés, pas un graphe complet ; les empreintes fournies ne vérifient pas les fichiers téléchargés.','Nur Installationspfad-Inventar, kein vollständiger Graph; gelieferte Prüfsummen prüfen keine heruntergeladenen Dateien.','Somente inventário de caminhos, não grafo completo; integridade fornecida não verifica arquivos baixados.','Solo inventario dei percorsi, non grafo completo; le impronte fornite non verificano file scaricati.'],
 ['Trust depends on independently obtained expected identity and key fingerprint. No certificate, transparency log or build-process attestation checked.','La confianza depende de identidad y huella obtenidas por separado. No verifica certificados, registros ni procesos de compilación.','La confiance dépend des valeurs attendues obtenues indépendamment. Aucun certificat, journal de transparence ou processus de compilation vérifié.','Vertrauen erfordert unabhängig ermittelte Identität und Fingerabdruck. Keine Zertifikate, Transparenzprotokolle oder Build-Prozesse geprüft.','A confiança depende de identidade e impressão obtidas independentemente. Não verifica certificados, registros ou processos de compilação.','La fiducia richiede identità e impronta ottenute indipendentemente. Nessuna verifica di certificati, registri o processi di compilazione.']
];
const errors=['Invalid input or input/output limit exceeded. Split the request; supplied values are not included in errors.','Entrada no válida o límite excedido. Divide la solicitud; los errores no incluyen valores aportados.','Entrée non valide ou limite dépassée. Divisez la demande ; les erreurs ne contiennent pas les valeurs fournies.','Ungültige Eingabe oder Grenze überschritten. Anfrage aufteilen; Fehler enthalten keine Eingabewerte.','Entrada inválida ou limite excedido. Divida a solicitação; erros não incluem valores fornecidos.','Input non valido o limite superato. Dividere la richiesta; gli errori non includono i valori forniti.'];
const summaries=['Results: {n} · Status: {status}','Resultados: {n} · Estado: {status}','Résultats : {n} · État : {status}','Ergebnisse: {n} · Status: {status}','Resultados: {n} · Estado: {status}','Risultati: {n} · Stato: {status}'];
const messages=['Offline analysis completed.','Análisis local completado.','Analyse locale terminée.','Lokale Analyse abgeschlossen.','Análise local concluída.','Analisi locale completata.'];
const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const str=(maxLength,minLength=1,description)=>({type:'string',minLength,maxLength,...(description?{description}:{})});
const arr=(items,maxItems,minItems=0)=>({type:'array',items,minItems,maxItems});
const lock=str(65536,1,'Explicit npm package-lock JSON text, lockfileVersion2 or3. Maximum60 installed paths; no links/workspaces.');
const schemas=[obj({files:arr(obj({path:str(160),text:str(32768,0)}),12,1)}),obj({lock,metadata:arr(obj({path:str(240),expression:str(256)}),60),policy:obj({allow:arr(str(256),60),deny:arr(str(256),60)})}),obj({lock}),obj({algorithm:{type:'string',enum:['ed25519']},artifactBase64:str(43692,0,'Canonical base64 artifact bytes, at most32769 decoded bytes.'),sha256:{...str(64),pattern:'^[a-f0-9]{64}$'},identity:str(160),expectedIdentity:str(160),publicKeyPem:str(1024,1,'Ed25519 SPKI PEM public key only.'),expectedKeySha256:{...str(64),pattern:'^[a-f0-9]{64}$',description:'Independently obtained SHA256 of public-key SPKI DER bytes.'},signatureBase64:str(88,88,'Ed25519 signature over UTF8 sara-artifact-v1\\n followed by JSON.stringify([identity,sha256]); see README.')})];
const ids=['secret-scanner','license-auditor','sbom-builder','artifact-provenance-verifier'], functions=['scan','audit','build','verifyArtifact'];
const common=`// Validate this deliberately small, closed schema vocabulary at every handler boundary.
export function validate(value,schema) {
 if(schema.type==='object') { if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>!Object.hasOwn(value,k))) throw new Error('input'); for(const k of Object.keys(value)) validate(value[k],schema.properties[k]); }
 else if(schema.type==='array') { if(!Array.isArray(value)||value.length<schema.minItems||value.length>schema.maxItems) throw new Error('input'); value.forEach(x=>validate(x,schema.items)); }
 else if(schema.type==='string') { if(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity)||schema.enum&&!schema.enum.includes(value)||schema.pattern&&!new RegExp(schema.pattern).test(value)) throw new Error('input'); }
 else throw new Error('schema');
}
`;
for(let i=0;i<4;i++) {
 const dir=join(root,'store/plugins',ids[i]); mkdirSync(dir,{recursive:true});
 const labels=Object.fromEntries(langs.map((lang,j)=>[lang,{title:titles[i][j],description:descriptions[i][j],scope:scopes[i][j],error:errors[j],summary:summaries[j],message:messages[j]}]));
 const write=(name,data)=>writeFileSync(join(dir,name),data);
 write('labels.json',JSON.stringify(labels,null,2)+'\n'); write('schema.json',JSON.stringify(schemas[i],null,2)+'\n'); write('validation.mjs',common);
 write('workflow.d.mts',`export const labels: Record<string,{title:string;description:string;scope:string;error:string;summary:string;message:string}>;\nexport const parameters: any;\nexport function handle(args: any,lang?: string): Promise<{content:string;card:{title:string;lines:string[]}}>;\n`);
 write('workflow.mjs',`import { ${functions[i]} as analyze } from './engine.mjs';
import { validate } from './validation.mjs';
import labels from './labels.json' with {type:'json'};
import parameters from './schema.json' with {type:'json'};
export { labels, parameters };
export async function handle(args,lang='en') {
 const l=labels[lang]??labels.en;
 try {
  validate(args,parameters);
  const report=analyze(args); report.message=l.message; report.scope=l.scope;
  const n=report.findings?.length??report.packages?.length??report.bom?.components?.length??Number(report.verified);
  const content=JSON.stringify(report);
  const card={title:l.title,lines:[l.summary.replace('{n}',String(n)).replace('{status}',report.status),l.scope.slice(0,200)]};
  if(Buffer.byteLength(content)>48000||Buffer.byteLength(JSON.stringify({v:1,type:'result',id:'r'.repeat(64),content,card}))>60000) throw new Error('limit');
  return {content,card};
 } catch { throw new Error(l.error); }
}
`);
 write('main.mjs',`import { plugin } from './sara-plugin.mjs';
import {handle,parameters,labels} from './workflow.mjs';
const tool={name:'analyze',description:labels.en.description,permission:'ask',parameters,run:(args,sara)=>handle(args,sara.lang)};
plugin({tools:[tool],init:sara=>{tool.description=(labels[sara.lang]??labels.en).description;}});
`);
 copyFileSync(join(root,'examples/plugins/sara-plugin.mjs'),join(dir,'sara-plugin.mjs'));
 const manifest={manifest:1,id:ids[i],name:titles[i][0],version:'1.0.0',description:descriptions[i][0],author:'Sara team',license:'MIT',sara:'>=2.68.0 <3.0.0',main:'main.mjs',permissions:{tools:['analyze'],hooks:[],callTools:[],network:[],files:{read:[],write:[]},settings:false,cards:false,model:{callsPerDay:0,tokensPerDay:0},memory:'none'},i18n:Object.fromEntries(langs.slice(1).map((l,j)=>[l,{[titles[i][0]]:titles[i][j+1],[descriptions[i][0]]:descriptions[i][j+1]}]))};
 write('sara-plugin.json',JSON.stringify(manifest,null,2)+'\n');
 copyFileSync(join(root,'store/plugins/document-desk/LICENSE'),join(dir,'LICENSE'));
 write('CHANGES.md','#1.0.0\n\nInitial deterministic, offline native analyzer with bounded explicit inputs, six locales, and invocation-scoped cards.\n');
 write('engine.d.mts',`export function ${functions[i]}(args: any): any;\n`+(i===3?'export function signingPayload(identity: string, sha256: string): Buffer;\n':''));
}
console.log('Assembled4 standalone native packages; SDK copied byte-for-byte; engines retained.');
