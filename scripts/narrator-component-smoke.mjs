// Real-browser proof for the pinned eSpeak-NG phonemizer that replaced the npm
// `phonemizer` package in the local narrator.
//
// It checks, on an owned fixture and an isolated loopback candidate preview:
//   1. the component really loads its worker JS, WASM and data file from the
//      deployed-relative paths, and the served bytes hash to the manifest,
//   2. browser IPA equals the output of the package being replaced, sentence by
//      sentence, for the sentences compared in the build report,
//   3. a manifest that does not match the served bytes stops the component,
//   4. the licence notices and the corresponding-source offer are reachable, and
//      the source archive downloads with the SHA-256 recorded in the manifest,
//   5. every request stays on the preview origin, and no request carries a body.
//
//   LATTE_READER_URL=http://127.0.0.1:4191/ node scripts/narrator-component-smoke.mjs
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright'
import {get as httpGet} from 'node:http'
import {get as httpsGet} from 'node:https'

// Vite marks .gz as Content-Encoding:gzip; fetch transparently decompresses it.
// Source archive integrity concerns the original gzip bytes, not decoded tar.
const rawArchive = url => new Promise((resolve, reject) => {
  const get = new URL(url).protocol === 'https:' ? httpsGet : httpGet
  get(url, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => response.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(Error(`archive status ${response.statusCode}`)))
    response.on('error', reject)
  }).on('error', reject)
})

const base=process.env.LATTE_READER_URL||'http://127.0.0.1:4191/'
const origin=new URL(base).origin
const out=process.env.LATTE_EVIDENCE||'.runtime/narrator-component-evidence'
await mkdir(out,{recursive:true})
const fixture=JSON.parse(await readFile(new URL('../tests/fixtures/narrator-ipa-parity.json',import.meta.url),'utf8'))
const manifestResponse=await fetch(new URL('/voice/espeak/build-manifest.json',origin))
assert.ok(manifestResponse.ok,'the manifest must be served')
const manifest=await manifestResponse.json()
const source=manifest.correspondingSource
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex')
const bytesOf=async response=>Buffer.from(await response.body())

const browser=await chromium.launch()
const context=await browser.newContext({viewport:{width:1440,height:1000}})
const page=await context.newPage()
const requests=[],errors=[],external=[]
const served=Object.fromEntries(manifest.objectCode.map(entry=>[entry.file,entry]))
const reading=[],componentResponses=[]
let recording=true
page.on('request',request=>{
  if(new URL(request.url()).origin!==origin) external.push(request.url())
  requests.push({url:request.url(),method:request.method(),hasBody:!!request.postData()})
})
page.on('response',response=>{
  if(!recording) return
  const name=manifest.objectCode.map(entry=>entry.file).find(file=>response.url().endsWith(file))
  if(!name) return
  reading.push((async()=>{
    const bytes=await bytesOf(response)
    componentResponses.push({file:name,bytes:bytes.length,sha256:sha256(bytes)})
    served[name]={...served[name],url:response.url(),status:response.status(),contentType:response.headers()['content-type']??'',servedBytes:bytes.length,servedSha256:sha256(bytes)}
  })().catch(error=>errors.push(`response:${name}:${error.message}`)))
})
page.on('pageerror',error=>errors.push(error.message))

await page.goto(base)
assert.equal(await page.evaluate(()=>window.__LATTE_PRIVATE_NARRATOR__===true),false,'test the candidate build, not the separate private trial')
// The Voices panel, and with it the engine choice, only exists once a document
// is open: use the owned reading fixture.
await page.locator('input[type=file]').setInputFiles('tests/fixtures/reading-quality.pdf')
await page.waitForFunction(()=>document.body.textContent.includes('Extraction complete'))

// 1 + 2: phonemize in a real browser and compare with the replaced package.
const results=await page.evaluate(async({language,sentences})=>{
  const {phonemize,listVoices}=await import('/voice/espeak/phonemizer.mjs')
  const out={}
  for(const sentence of sentences) out[sentence.text]=await phonemize(sentence.text,language)
  return {voices:(await listVoices()).length,out}
},{language:fixture.language,sentences:fixture.sentences})
await Promise.all(reading)
recording=false
const compared=fixture.sentences.map(({text,expected})=>({text,expected,actual:results.out[text],identical:JSON.stringify(expected)===JSON.stringify(results.out[text])}))
assert.equal(compared.filter(entry=>entry.identical).length,compared.length,`IPA must match the replaced package for every sentence: ${JSON.stringify(compared.filter(entry=>!entry.identical))}`)
assert.ok(results.voices>0,'the mounted data package must list voices')

// The three component files must have been fetched from this origin, whole, and
// hash to what the manifest claims.
for(const entry of manifest.objectCode){
  const seen=served[entry.file]
  assert.equal(componentResponses.filter(response=>response.file===entry.file).length,1,`${entry.file} must be fetched once, not deduplicated`)
  assert.equal(seen.status,200,`${entry.file} must be served: ${JSON.stringify(seen)}`)
  assert.equal(seen.servedBytes,entry.bytes,`${entry.file} length`)
  assert.equal(seen.servedSha256,entry.sha256,`${entry.file} sha256`)
  assert.ok(seen.url.startsWith(origin+'/voice/espeak/'),`${entry.file} must come from the deployed-relative path: ${seen.url}`)
}

// 3: a manifest that does not match the bytes must stop the component.
const tampered={...manifest,objectCode:manifest.objectCode.map(entry=>entry.role==='wasm'?{...entry,sha256:'0'.repeat(64)}:entry)}
await page.route('**/voice/espeak/build-manifest.json',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(tampered)}))
const refused=await page.evaluate(async()=>{
  const {phonemize}=await import('/voice/espeak/phonemizer.mjs?tampered=1')
  try { await phonemize('Hello world.','en-us'); return 'SPOKE' } catch(error) { return String(error&&error.message) }
})
await page.unroute('**/voice/espeak/build-manifest.json')
assert.match(refused,/HASH_MISMATCH:espeakng\.worker\.wasm/,'a hash mismatch must refuse to phonemize')

// 4: notices, modification record and the source offer, reachable from this origin.
await page.getByLabel('Reading engine',{exact:true}).selectOption('local')
const notices=page.locator('[data-local-notices=ready]')
await notices.waitFor({timeout:30000})
const links=await notices.locator('a').evaluateAll(anchors=>anchors.map(anchor=>({text:anchor.textContent,href:anchor.href,download:anchor.hasAttribute('download')})))
assert.equal(links.length,3,'licences, corresponding source and the archive must all be linked')
const archiveHref=new URL(source.file,new URL('/voice/espeak/',origin)).href
const reachability=[]
for(const link of links){
  const response=await fetch(link.href)
  const archive=link.href===archiveHref
  const bytes=archive&&response.ok?await rawArchive(link.href):null
  reachability.push({text:link.text,href:link.href,download:link.download,status:response.status,contentType:response.headers.get('content-type'),bytes:bytes?bytes.length:null,sha256:bytes?sha256(bytes):null})
}
for(const entry of reachability) assert.equal(entry.status,200,`${entry.href} must be served`)
const archive=reachability.find(entry=>entry.href===archiveHref)
assert.ok(archive&&archive.download,'the source archive must be the linked download')
assert.equal(archive.bytes,source.bytes,'source archive length')
assert.equal(archive.sha256,source.sha256,'source archive sha256')
const archiveHead=new Uint8Array(await rawArchive(archiveHref))
assert.deepEqual([...archiveHead.subarray(0,2)],[0x1f,0x8b],'the archive must be gzip')
const offer=await (await fetch(new URL(source.offer,new URL('/voice/espeak/',origin)))).text()
assert.match(offer,/GNU GPL version 3, section 6\(d\)/)
assert.match(offer,/4870adfa25b1a32b4361592f1be8a40337c58d6c/)

// 5: privacy. Nothing left this origin and nothing carried a body.
assert.deepEqual(external,[],'no request may leave the preview origin')
assert.deepEqual(requests.filter(request=>request.hasBody),[],'no request may carry a body')

const evidence={base,componentResponses,observedComponentBodyBytes:componentResponses.reduce((sum,response)=>sum+response.bytes,0),voices:results.voices,requests:requests.length,served,compared,identical:compared.length,tamperedRefused:refused,links:reachability,manifest:{commit:manifest.upstream.commit,sourceSha256:source.sha256,sourceBytes:source.bytes},pageErrors:errors}
await writeFile(`${out}/component-results.json`,JSON.stringify(evidence,null,2))
console.log(JSON.stringify({base,voices:results.voices,requests:requests.length,identical:`${compared.length}/${compared.length}`,served:Object.fromEntries(Object.entries(served).map(([file,value])=>[file,`${value.status} ${value.servedBytes}B ${value.contentType}`])),tamperedRefused:refused,links:reachability.map(({text,status,bytes})=>({text,status,bytes})),sourceSha256:archive.sha256,external,pageErrors:errors},null,2))
await context.close();await browser.close()
