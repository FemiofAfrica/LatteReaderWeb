import assert from 'node:assert/strict'
import {chromium} from 'playwright'
import {mkdir,writeFile} from 'node:fs/promises'
const out=process.env.LATTE_EVIDENCE || '/root/.hermes/cache/scratch/latte-mac-narrator-trial'
await mkdir(out,{recursive:true})
const browser=await chromium.connectOverCDP(process.env.LATTE_CDP || 'http://127.0.0.1:9222')
const context=await browser.newContext({viewport:{width:1440,height:1000}})
const page=await context.newPage()
const requests=[]; const errors=[]
page.on('request',r=>requests.push({url:r.url(),method:r.method(),body:!!r.postData()}))
page.on('pageerror',e=>errors.push(e.message))
await page.addInitScript(()=>{
  window.__trial={inputs:[],metrics:[],pcm:[],audio:[],ticks:[],status:[]}
  window.addEventListener('latte-local-state',event=>window.__trial.status.push({time:performance.now(),...event.detail}))
  const NativeWorker=Worker
  window.Worker=class extends NativeWorker{
    constructor(url,opts){super(url,opts);this.local=String(url).includes('__narrator');if(this.local)this.addEventListener('message',({data})=>{
      if(data.metrics)window.__trial.metrics.push(data.metrics)
      if(data.pcm&&window.__trial.pcm.length<4)window.__trial.pcm.push(Array.from(new Float32Array(data.pcm)))
    })}
    postMessage(d,...args){if(this.local&&d.op==='generate')window.__trial.inputs.push(d.text);return super.postMessage(d,...args)}
  }
  const start=AudioBufferSourceNode.prototype.start
  AudioBufferSourceNode.prototype.start=function(...args){window.__trial.audio.push({action:'start',offset:args[1]||0,seconds:this.buffer.duration,state:this.context.state,time:performance.now()});return start.apply(this,args)}
  const stop=AudioBufferSourceNode.prototype.stop
  AudioBufferSourceNode.prototype.stop=function(...args){window.__trial.audio.push({action:'stop',time:performance.now()});return stop.apply(this,args)}
  let last=performance.now();setInterval(()=>{const now=performance.now();window.__trial.ticks.push(now-last);last=now},50)
})
await page.goto(process.env.LATTE_READER_URL || 'http://127.0.0.1:4187/')
await page.locator('input[type=file]').setInputFiles('tests/fixtures/reading-quality.pdf')
await page.waitForFunction(()=>document.body.textContent.includes('Extraction complete'))
assert.equal(requests.filter(r=>r.url.includes('__narrator')).length,0)
await page.getByLabel('Reading engine',{exact:true}).selectOption('local')
assert.equal(requests.filter(r=>r.url.includes('__narrator')).length,0)
await page.getByRole('button',{name:'Enable local narrator',exact:true}).click()
await page.locator('[data-local-status=ready]').waitFor({timeout:180000})
await page.getByRole('button',{name:'Read-along text',exact:true}).click()
await page.getByRole('button',{name:'Start reading',exact:true}).click()
await page.locator('[data-local-status=playing]').waitFor({timeout:120000})
await page.waitForTimeout(400)
const marks=await page.locator('mark').allTextContents()
await page.screenshot({path:out+'/mac-reader-playing.png',fullPage:true})
assert.ok(marks.length)
await page.getByRole('button',{name:'Pause reading',exact:true}).click()
await page.locator('[data-local-status=paused]').waitFor()
const before=await page.evaluate(()=>window.__trial.audio.length)
await page.waitForTimeout(700)
assert.equal(await page.evaluate(()=>window.__trial.audio.length),before)
await page.getByRole('button',{name:'Next page',exact:true}).click()
assert.match(await page.getByLabel('Current page',{exact:true}).innerText(),/^2/)
await page.getByRole('button',{name:'Resume reading',exact:true}).click()
await page.locator('[data-local-status=playing]').waitFor()
const resumed=await page.evaluate(()=>window.__trial.audio.filter(a=>a.action==='start').at(-1))
assert.ok(resumed.offset>0)
await page.getByRole('button',{name:'Stop reading',exact:true}).click()
const stops=await page.evaluate(()=>window.__trial.audio.length)
await page.waitForTimeout(2000)
assert.equal(await page.evaluate(()=>window.__trial.audio.length),stops)
await page.screenshot({path:out+'/mac-reader.png',fullPage:true})
// Finish both real cross-page chunks in the reader; queued generation cannot move page.
await page.getByLabel('Go to page',{exact:true}).fill('1')
const inputStart=await page.evaluate(()=>window.__trial.inputs.length)
await page.getByRole('button',{name:'Start reading',exact:true}).click()
await page.locator('[data-local-status=playing]').waitFor({timeout:120000})
await page.locator('[data-local-status=ready]').waitFor({timeout:120000})
const completedInputs=await page.evaluate(n=>window.__trial.inputs.slice(n),inputStart)
assert.equal(completedInputs.join(''),'f ff fi fl ffi ffl ff fi fl ffi ffl “fine” Five fine friends find fresh coffee. A well-known difference.')
assert.match(await page.getByLabel('Current page',{exact:true}).innerText(),/^2/)
// Paused explicit seek stays silent and regenerates only after Resume.
await page.getByLabel('Go to page',{exact:true}).fill('1')
await page.getByRole('button',{name:'Start reading',exact:true}).click()
await page.locator('[data-local-status=playing]').waitFor({timeout:120000})
await page.getByRole('button',{name:'Pause reading',exact:true}).click()
const seekAudio=await page.evaluate(()=>window.__trial.audio.length)
await page.getByRole('button',{name:'Next sentence',exact:true}).click()
await page.waitForTimeout(700)
assert.equal(await page.evaluate(()=>window.__trial.audio.length),seekAudio)
await page.getByRole('button',{name:'Resume reading',exact:true}).click()
await page.locator('[data-local-status=playing]').waitFor({timeout:120000})
assert.equal(await page.evaluate(()=>window.__trial.inputs.at(-1)),'A well-known difference.')
await page.getByRole('button',{name:'Stop reading',exact:true}).click()
await page.setViewportSize({width:504,height:900})
await page.getByRole('tab',{name:'Voices',exact:true}).click()
await page.getByRole('button',{name:'Cancel and release voice',exact:true}).scrollIntoViewIfNeeded()
const mobileCapture = await page.screenshot({path:out+'/mac-voices-504.png',fullPage:true})
const result=await page.evaluate(()=>({ua:navigator.userAgent,platform:navigator.platform,cores:navigator.hardwareConcurrency,...window.__trial}))
result.requests=requests;result.errors=errors;result.marks=marks;result.mobileScreenshotValid=mobileCapture.length>1000
await writeFile(out+'/reader-results.json',JSON.stringify(result,null,2))
for(let n=0;n<result.pcm.length;n++){
  const pcm=result.pcm[n],b=Buffer.alloc(44+pcm.length*2)
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(pcm.length*2,40)
  pcm.forEach((x,i)=>b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,x))*32767),44+i*2));await writeFile(`${out}/mac-chunk-${n+1}.wav`,b)
}
console.log(JSON.stringify({ua:result.ua,cores:result.cores,inputs:result.inputs,metrics:result.metrics,audio:result.audio,marks,errors,requests:requests.length},null,2))
await context.close(); await browser.close()
