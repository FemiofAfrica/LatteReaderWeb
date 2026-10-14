import assert from 'node:assert/strict'
import {chromium} from 'playwright'
import {mkdir,writeFile} from 'node:fs/promises'
const out=process.env.LATTE_EVIDENCE||'/root/.hermes/cache/scratch/latte-mac-narrator-trial'
await mkdir(out,{recursive:true})
const browser=await chromium.connectOverCDP(process.env.LATTE_CDP||'http://127.0.0.1:9222')
const context=await browser.newContext({viewport:{width:1440,height:1000}})
const page=await context.newPage()
const requests=[]
page.on('request',r=>requests.push({url:r.url(),method:r.method(),body:!!r.postData()}))
await page.goto(process.env.LATTE_READER_URL||'http://127.0.0.1:4187/')
await page.locator('input[type=file]').setInputFiles('tests/fixtures/reading-quality.pdf')
await page.waitForFunction(()=>document.body.textContent.includes('Extraction complete'))
const proof=await page.evaluate(()=>({ua:navigator.userAgent,platform:navigator.platform,cores:navigator.hardwareConcurrency,crossOriginIsolated}))
assert.match(proof.ua,/Macintosh/)
const init=await page.evaluate(async()=>{
  window.__bench={worker:new Worker('/__narrator/worker.mjs',{type:'module'}),id:0,pending:new Map(),gaps:[],last:performance.now(),maxPcmBytes:0}
  const b=window.__bench
  b.worker.onmessage=({data:d})=>{const p=b.pending.get(d.id);b.pending.delete(d.id);d.ok?p.resolve(d):p.reject(Error(d.error))}
  window.__rpc=(op,fields={})=>new Promise((resolve,reject)=>{const id=++b.id;b.pending.set(id,{resolve,reject});b.worker.postMessage({id,op,...fields})})
  b.timer=setInterval(()=>{const now=performance.now();b.gaps.push(now-b.last);b.last=now},50)
  return await window.__rpc('init')
})
const sentences=[
 'The morning light fell across the table, and the room slowly came to life.',
 'She opened the book and found a small note tucked between the pages.',
 'We do not need to hurry, because the train will arrive in another hour.',
 'Every afternoon, the old gardener watered the flowers beside the gate.',
 'When the rain finally stopped, they walked down to the river together.',
 'I thought you might enjoy this story about a boy who learned to listen.',
 'The little coffee shop was quiet, apart from the gentle sound of music.',
 'Please keep the window open while I finish reading the final chapter.',
 'They had travelled a long way, but the journey was not quite over yet.',
 'At the end of the day, he put the letter away and turned off the light.'
]
const metrics=[]
for(let i=0;i<sentences.length+2;i++){
 const text=sentences[i%sentences.length],speed=i===10?0.5:i===11?2:1
 const promise=page.evaluate(async({text,speed})=>{
   const d=await window.__rpc('generate',{text,speed});const p=new Float32Array(d.pcm)
   if(!p.length||!p.every(Number.isFinite))throw Error('Invalid real PCM')
   window.__bench.maxPcmBytes=Math.max(window.__bench.maxPcmBytes,p.byteLength)
   return d.metrics
 },{text,speed})
 // Real PDF browsing occurs while the dedicated worker synthesizes.
 await page.getByRole('button',{name:i%2===0?'Next page':'Previous page',exact:true}).click()
 const m=await promise; metrics.push({text,speed,...m});console.log(JSON.stringify(metrics.at(-1)))
}
const ui=await page.evaluate(()=>{clearInterval(window.__bench.timer);return {maxTickGapMs:Math.max(...window.__bench.gaps),gapsOver200:window.__bench.gaps.filter(x=>x>200).length,ticks:window.__bench.gaps.length,maxPcmBytes:window.__bench.maxPcmBytes,memory:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null}})
const p95=a=>[...a].sort((a,b)=>a-b)[Math.ceil(a.length*.95)-1]
const warm=metrics.slice(0,10)
const result={proof,init,metrics,summary:{samples:10,p95GenerateMs:p95(warm.map(m=>m.generateMs)),p95Rtf:p95(warm.map(m=>m.rtf)),...ui},requests}
await writeFile(out+'/mac-benchmark.json',JSON.stringify(result,null,2))
await page.screenshot({path:out+'/mac-benchmark.png',fullPage:true})
console.log(JSON.stringify({proof,summary:result.summary,init},null,2))
await context.close();await browser.close()
