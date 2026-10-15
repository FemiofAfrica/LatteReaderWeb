import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const base=process.env.LATTE_READER_URL;assert(base,'set LATTE_READER_URL explicitly');const origin=new URL(base).origin;
const out=process.env.LATTE_EVIDENCE||'/root/.hermes/cache/scratch/latte-integration-proof/narrator';await mkdir(out,{recursive:true});
const pins=JSON.parse(await readFile('src/speech/local/narratorPins.json'));const hash=b=>createHash('sha256').update(b).digest('hex');
const browser=await chromium.launch();const result={base,phases:{},requests:[],assets:[]};
const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();
page.on('request',r=>result.requests.push({url:r.url(),method:r.method(),body:r.postData()}));
await context.route('**/voice/**',async route=>{const response=await route.fetch();const bytes=Buffer.from(await response.body());result.assets.push({path:new URL(route.request().url()).pathname,bytes:bytes.length,hash:hash(bytes)});await route.fulfill({response,body:bytes});});
await page.addInitScript(()=>{
 window.__proof={inputs:[],metrics:[],ready:[],failed:[],states:[],starts:[],pcm:[],positions:[]};
 for(const [event,key] of [['latte-local-ready','ready'],['latte-local-failed','failed'],['latte-local-state','states']])window.addEventListener(event,e=>window.__proof[key].push(e.detail));
 const W=Worker;window.Worker=class extends W{constructor(url,opts){super(url,opts);this.n=String(url).includes('narrator.worker');if(this.n)this.addEventListener('message',e=>{if(e.data.metrics)window.__proof.metrics.push(e.data.metrics)})}postMessage(m,...args){if(this.n&&m.op==='generate')window.__proof.inputs.push(m.text);return super.postMessage(m,...args)}};
 const start=AudioBufferSourceNode.prototype.start;AudioBufferSourceNode.prototype.start=function(...a){window.__proof.starts.push({clock:this.context.currentTime,offset:a[1]||0,state:this.context.state,duration:this.buffer.duration});return start.apply(this,a)};
 const create=AudioContext.prototype.createBuffer;AudioContext.prototype.createBuffer=function(...a){const b=create.apply(this,a),copy=b.copyToChannel.bind(b);b.copyToChannel=(data,c)=>{window.__proof.pcm.push(Array.from(data));return copy(data,c)};return b};
});
const snap=()=>page.evaluate(()=>JSON.parse(JSON.stringify(window.__proof)));
const state=s=>page.locator(`[data-local-status=${s}]`).waitFor({timeout:180000});
await page.goto(base);await page.waitForTimeout(800);assert.equal(result.assets.length,0);
await page.locator('input[type=file]').setInputFiles('tests/fixtures/misaki-owned.pdf');await page.waitForFunction(()=>document.body.textContent.includes('Ready to read')||document.body.textContent.includes('Ready to read'));
await page.locator('.local-narrator-controls select').selectOption('local');await page.waitForTimeout(500);assert.equal(result.assets.length,0);
result.phases.beforeEnable={downloads:0};await page.locator('.local-narrator-controls button').first().click();await state('ready');
const cold=await snap();assert.equal(cold.ready[0].graphSha256,pins.graph.sha256);assert.equal(cold.ready[0].voiceSha256,pins.voice.sha256);assert.equal(cold.ready[0].runtimeWasmSha256,pins.runtime.wasm.sha256);
for(const entry of pins.transfer.entries){const matches=result.assets.filter(a=>a.path==='/voice/narrator/'+entry.path);assert.equal(matches.length,1,entry.path);assert.equal(matches[0].bytes,entry.bytes);if(entry.sha256)assert.equal(matches[0].hash,entry.sha256);}
const expectedBytes=result.assets.reduce((n,a)=>n+a.bytes,0);assert.equal(expectedBytes,pins.transfer.bytes);assert(!result.assets.some(a=>/espeak/.test(a.path)));
result.phases.optIn={bytes:expectedBytes,assets:result.assets.length,worker:cold.ready[0]};
await page.getByRole('button',{name:'Read-along text',exact:true}).click();await page.getByRole('button',{name:'Start reading',exact:true}).click();await state('playing');await page.waitForTimeout(450);
await page.getByRole('button',{name:'Pause reading',exact:true}).click();await state('paused');const paused=await snap();await page.waitForTimeout(300);await page.getByRole('button',{name:'Resume reading',exact:true}).click();await state('playing');const resumed=await snap();assert(resumed.starts.at(-1).offset>0);assert.equal(resumed.inputs.filter(t=>t===paused.inputs[0]).length,1);
await page.getByRole('button',{name:'Next page',exact:true}).click();await page.waitForTimeout(200);assert.equal(await page.getByRole('button',{name:'Follow reading'}).count(),1);assert.equal((await snap()).starts.length,resumed.starts.length);await page.getByRole('button',{name:'Follow reading'}).click();
await state('ready');const played=await snap();assert(played.starts.length>=4);assert(played.metrics.some(m=>m.learnedCalls>0));assert(played.metrics.every(m=>m.coveredUnits===m.sourceUnits&&m.trimSamples===0));assert(played.starts.every(s=>s.state==='running'));assert(played.starts.at(-1).clock>2);
const prose=JSON.parse(await readFile('tests/fixtures/misaki-owned.json'));assert.equal(played.inputs.join(''),prose.join(' '));
const pcm=played.pcm.flat();assert(pcm.every(Number.isFinite));const rms=Math.sqrt(pcm.reduce((n,x)=>n+x*x,0)/pcm.length);assert(rms>0.001);
const wav=Buffer.alloc(44+pcm.length*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length*2,40);pcm.forEach((x,i)=>wav.writeInt16LE(Math.round(Math.max(-1,Math.min(1,x))*32767),44+i*2));await writeFile(out+'/reader-generated.wav',wav);
result.phases.playback={inputs:played.inputs,metrics:played.metrics,starts:played.starts,rms,wavHash:hash(wav),generatedSeconds:pcm.length/24000,physicalDeviceAudibility:'not measured'};await page.screenshot({path:out+'/reader.png'});
await page.reload();await page.waitForTimeout(1500);const mark=result.assets.length;await page.locator('.local-narrator-controls select').selectOption('local');await page.waitForTimeout(500);assert.equal(result.assets.length,mark);assert.equal((await snap()).starts.length,0);result.phases.reload={automaticDownloads:0,automaticPlayback:0};
// A refused unit is contained: the rest of a part is still spoken, a token-budget
// overflow still refuses as TOKEN_LIMIT so the engine can split at a word boundary,
// and only a genuinely empty part after containment may still refuse.
const limits=await page.evaluate(async()=>{const text=await(await fetch('/')).text();const src=[...document.querySelectorAll('script')].find(s=>s.src)?.src;const code=await(await fetch(src)).text();const path=code.match(/\/assets\/narrator\.worker[^"']+\.js/)?.[0];if(!path)throw Error('worker path');const w=new Worker(path,{type:'module'});let id=0;const rpc=op=>new Promise(resolve=>{const n=++id;const h=e=>{if(e.data.id===n){w.removeEventListener('message',h);resolve(e.data)}};w.addEventListener('message',h);w.postMessage({...op,id:n})});await rpc({op:'init'});const cases=[];for(const input of ['😀','東京','12:99','1,23','1/2','1e10','x'.repeat(70),'hyperglorpificationistically','A '.repeat(300),'(Wrong way round, there!)','Simon & Schuster.']){const r=await rpc({op:'generate',text:input});cases.push({input,error:r.error,ok:r.ok,metrics:r.metrics})}w.terminate();return cases});
const by=label=>limits.find(c=>c.input===label||(typeof label==='string'&&c.input.startsWith?.(label))||c.input===label)
const token=limits.find(c=>c.input.startsWith('A '))
assert.equal(token.error,'TOKEN_LIMIT');assert.equal(token.ok,false)
// Brackets and ampersands are contained, not fatal.
for(const label of ['(Wrong way round, there!)','Simon & Schuster.']){const c=limits.find(x=>x.input===label);assert.equal(c.ok,true,label);assert.equal(c.metrics?.contained,true,label)}
// Emoji and CJK have no spoken form: they may still refuse after containment empties the part.
for(const label of ['😀','東京']){const c=limits.find(x=>x.input===label);assert.equal(c.ok,false,label);assert.equal(c.error,'UNSUPPORTED_TEXT',label)}
// Numbers that used to throw the whole-text guard are now spelled and spoken.
for(const label of ['12:99','1,23','1/2','1e10']){const c=limits.find(x=>x.input===label);assert.equal(c.ok,true,label)}
result.phases.refusals=limits;
// Corrupt each class of shipped input, not merely the acoustic graph.
for(const pin of [pins.graph.parts[0],pins.runtime.bundle,pins.runtime.glue,pins.runtime.wasm,...pins.phonemizer.files]){
 const hostile=await browser.newContext({viewport:{width:1440,height:1000}});await hostile.route('**/voice/narrator/'+pin.path,async route=>{const response=await route.fetch();const b=Buffer.from(await response.body());b[Math.floor(b.length/2)]^=255;await route.fulfill({response,body:b})});const p=await hostile.newPage();await p.goto(base);await p.locator('input[type=file]').setInputFiles('tests/fixtures/misaki-owned.pdf');await p.waitForFunction(()=>document.querySelector('canvas'));await p.locator('.local-narrator-controls select').selectOption('local');await p.locator('.local-narrator-controls button').first().click();await p.locator('[data-local-status=error]').waitFor({timeout:180000});result.phases['tamper:'+pin.path]={failedClosed:true,message:await p.locator('[data-local-status=error]').innerText()};await hostile.close();
}
assert(result.requests.every(r=>new URL(r.url).origin===origin&&!r.body&&r.method==='GET'));assert(!result.requests.some(r=>/misaki-owned|Nkechi|Marivelle/.test(r.url)));result.privacy={external:0,bodies:0,textLeaks:0};
await writeFile(out+'/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify({bytes:expectedBytes,parts:played.inputs.length,learnedCalls:played.metrics.reduce((n,m)=>n+m.learnedCalls,0),rms,refusals:limits.length,wav:out+'/reader-generated.wav'},null,2));await browser.close();
