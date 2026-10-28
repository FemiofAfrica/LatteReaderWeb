// Public browser seam: owned real PDF, scroll ownership, chrome, reflow and keyboard.
import { chromium } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const url = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4192/'
const phase = process.env.LATTE_LAYOUT_PHASE ?? 'after'
const artifacts = `tests/artifacts/desktop-console/${phase}`
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch()
const results = [], failures = []
const check = (ok, text) => { if (!ok) failures.push(text) }
const filename = 'An afternoon with five friends - Complete collected chapters and annotated reading edition - 300 pages.pdf'
const bytes = await readFile('tests/fixtures/desktop-300.pdf')
const setup = async viewport => {
  const page = await browser.newPage({ viewport })
  await page.addInitScript(() => {
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text } } })
    Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [], cancel() {}, pause() {}, resume() {}, speak() {} } })
  })
  await page.goto(url)
  await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
  await page.locator('input[type=file]').setInputFiles({ name:filename, mimeType:'application/pdf', buffer:bytes })
  await page.waitForFunction(() => document.body.textContent.includes('Ready to read'), null, { timeout:60000 })
  await page.locator('canvas').waitFor()
  return page
}
const geometry = page => page.evaluate(() => {
  const rect = selector => {
    const el = document.querySelector(selector), r = el.getBoundingClientRect()
    return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom, right:r.right }
  }
  const viewer = document.querySelector('.preview-scroll')
  const body = document.body, root = document.documentElement
  return { body:{scrollHeight:body.scrollHeight, clientHeight:body.clientHeight, scrollWidth:body.scrollWidth, clientWidth:body.clientWidth}, root:{ scrollHeight:root.scrollHeight, clientHeight:root.clientHeight, scrollWidth:root.scrollWidth, clientWidth:root.clientWidth }, windowScrollY:scrollY,
    viewer:{ ...rect('.preview-scroll'), scrollHeight:viewer.scrollHeight, clientHeight:viewer.clientHeight, scrollTop:viewer.scrollTop, scrollWidth:viewer.scrollWidth, clientWidth:viewer.clientWidth },
    chrome:Object.fromEntries(['.topbar','.control-rail','.preview-header','.transport'].filter(s=>document.querySelector(s)).map(s=>[s,rect(s)])) }
})
for (const viewport of [{width:1024,height:768},{width:1100,height:800},{width:1440,height:900},{width:1920,height:1080}]) {
  const label = `${viewport.width}x${viewport.height}`
  const page = await setup(viewport)
  await page.screenshot({ path:`${artifacts}/${label}.png` })
  await page.getByRole('button', { name:'Find character voices' }).click()
  // Adversarial DOM-only growth beyond the product's six-speaker cap. No synthetic API data.
  await page.locator('.speaker-list ul').evaluate(ul => {
    const template = ul.firstElementChild
    for (let i=0; i<60; i++) { const row=template.cloneNode(true); row.querySelector('strong').textContent=`Long character display name ${i} with multiple words`; ul.append(row) }
  })
  await page.locator('.diagnostics-panel summary').click()
  const disclosure = page.locator('.document-details summary')
  if (await disclosure.count()) await disclosure.click()
  const engineDisclosure = page.locator('.engine-details summary')
  if (await engineDisclosure.count()) await engineDisclosure.click()
  const before = await geometry(page)
  await page.locator('.preview-scroll').evaluate(el => { el.scrollTop = 450 })
  await page.waitForTimeout(150)
  const after = await geometry(page)
  const rectsUnchanged=Object.keys(before.chrome).every(s=>JSON.stringify(before.chrome[s])===JSON.stringify(after.chrome[s]))
  check(rectsUnchanged, `${label}: a chrome rectangle changed during inner scroll`)
  const centerDelta=await page.evaluate(()=>{const c=document.querySelector('canvas').getBoundingClientRect(),v=document.querySelector('.preview-scroll').getBoundingClientRect();return c.x+c.width/2-(v.x+v.width/2)})
  check(Math.abs(centerDelta)<=1, `${label}: PDF is not centered in its viewer (${centerDelta}px)`)
  check(before.root.scrollHeight === before.root.clientHeight, `${label}: body scroll ${before.root.scrollHeight}/${before.root.clientHeight}`)
  check(before.body.scrollHeight === before.body.clientHeight, `${label}: body element grows ${before.body.scrollHeight}/${before.body.clientHeight}`)
  check(before.root.scrollWidth === before.root.clientWidth, `${label}: horizontal body overflow`)
  check(after.viewer.scrollTop > 100, `${label}: inner scrolling was not exercised`)
  const deltas = Object.fromEntries(Object.entries(before.chrome).map(([s,r]) => [s,after.chrome[s].y-r.y]))
  check(Object.values(deltas).every(d=>d===0), `${label}: chrome moved ${JSON.stringify(deltas)}`)
  const header = after.chrome['.preview-header'], transport = after.chrome['.transport']
  check(header.bottom <= after.viewer.y + 1 && after.viewer.bottom <= transport.y+1, `${label}: viewer/chrome overlap`)
  check(transport.bottom <= viewport.height, `${label}: transport unreachable`)
  const hits = await page.evaluate(() => [...document.querySelectorAll('.preview-header button,.preview-header input,.transport button')].filter(el=>!el.disabled).map(el=>{
    const r=el.getBoundingClientRect(), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
    return { name:el.getAttribute('aria-label') || el.textContent.trim() || el.type, width:r.width,height:r.height, reachable:!!hit&&(el===hit||el.contains(hit)), inHeader: !el.closest('.preview-header') || (r.top>=document.querySelector('.preview-header').getBoundingClientRect().top && r.bottom<=document.querySelector('.preview-header').getBoundingClientRect().bottom) }
  }))
  check(hits.every(h=>h.reachable&&h.inHeader), `${label}: control hidden or outside toolbar`)
  const sidebar = await page.evaluate(() => {
    const rail=document.querySelector('.control-rail').getBoundingClientRect(), list=document.querySelector('.speaker-list ul'), r=list.getBoundingClientRect()
    const analyze=document.querySelector('.control-rail .key-button'), a=analyze.getBoundingClientRect()
    list.scrollTop=150
    return {railBottom:rail.bottom,listTop:r.top,listBottom:r.bottom,listHeight:r.height,listScrollTop:list.scrollTop,analyzeBottom:a.bottom,analyzeHit:analyze.contains(document.elementFromPoint(a.x+a.width/2,a.y+a.height/2))}
  })
  check(sidebar.listHeight>=48 && sidebar.listBottom<=sidebar.railBottom && sidebar.analyzeBottom<=sidebar.railBottom && sidebar.analyzeHit && sidebar.listScrollTop>0, `${label}: sidebar content clipped ${JSON.stringify(sidebar)}`)
  if (phase !== 'before') {
    await page.locator('input[type=file]').setInputFiles({name:'invalid.pdf',mimeType:'application/pdf',buffer:Buffer.from('invalid PDF')})
    await page.getByRole('alert').waitFor()
    const errorState=await page.evaluate(()=>{const r=document.querySelector('.speaker-list ul').getBoundingClientRect(), rail=document.querySelector('.control-rail').getBoundingClientRect();return {listBottom:r.bottom,railBottom:rail.bottom,rootScroll:document.documentElement.scrollHeight-innerHeight}})
    check(errorState.rootScroll===0 && errorState.listBottom<=errorState.railBottom, `${label}: expanded error state clipped voices ${JSON.stringify(errorState)}`)
    await page.screenshot({path:`${artifacts}/${label}-error.png`})
  }
  await page.screenshot({path:`${artifacts}/${label}-stress.png`})
  results.push({ label,before,after,deltas,rectsUnchanged,centerDelta,hits,sidebar,stress:'60 cloned DOM speaker rows plus diagnostics, engine and metadata expanded; real app caps voices at six' })
  await page.close()
}
if (phase !== 'before') {
  for (const viewport of [{width:320,height:900},{width:390,height:900},{width:504,height:900},{width:768,height:1024},{width:512,height:384},{width:550,height:400},{width:720,height:450},{width:960,height:540}]) {
    // 512x384 and 720x450 are 1024x768 and 1440x900 at 200% browser zoom in CSS pixels.
    const {width,height}=viewport
    const page = await setup(viewport)
    const label = height<600?`200-percent-reflow-${width}x${height}`:`mobile-${width}`
    await page.waitForTimeout(400)
    check(await page.getByRole('tab').count()===3, `${label}: unified mobile tabs missing`)
    const state = await page.evaluate(() => ({ width:innerWidth,scrollWidth:document.documentElement.scrollWidth, headerBottom:document.querySelector('.preview-header').getBoundingClientRect().bottom, barTop:document.querySelector('.mobile-bar').getBoundingClientRect().top, canvasWidth:document.querySelector('canvas').getBoundingClientRect().width, viewerWidth:document.querySelector('.preview-scroll').clientWidth }))
    check(state.scrollWidth===width, `${label}: horizontal reflow overflow`)
    check(state.headerBottom < state.barTop, `${label}: chrome blocks all content`)
    check(state.canvasWidth<=state.viewerWidth, `${label}: initial mobile fit regressed`)
    await page.getByRole('tab', {name:'Read'}).focus()
    await page.keyboard.press('ArrowRight')
    check(await page.getByRole('tab',{name:'Voices'}).getAttribute('aria-selected')==='true', `${label}: tab arrow navigation failed`)
    await page.keyboard.press('Home')
    check(await page.getByRole('tab',{name:'Document'}).getAttribute('aria-selected')==='true', `${label}: tab Home navigation failed`)
    await page.getByRole('tab',{name:'Read'}).click()
    await page.screenshot({path:`${artifacts}/${label}.png`})
    results.push({label,...state})
    await page.close()
  }
  const page=await setup({width:1440,height:900})
  await page.emulateMedia({reducedMotion:'reduce'})
  const keyboard=[]
  for(let i=0;i<22;i++) {
    await page.keyboard.press('Tab')
    keyboard.push(await page.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e);return {tag:e.tagName,name:e.getAttribute('aria-label')||e.textContent.trim().slice(0,60),outline:s.outlineStyle,outlineWidth:s.outlineWidth}}))
  }
  check(keyboard.filter(k=>['BUTTON','INPUT','SUMMARY','A'].includes(k.tag)).every(k=>k.outline!=='none'&&parseFloat(k.outlineWidth)>=2), 'Keyboard control missing focus ring')
  await page.getByRole('button',{name:'Next page'}).focus(); await page.keyboard.press('Enter')
  check((await page.getByLabel('Current page').innerText()).startsWith('2'), 'Keyboard next-page failed')
  await page.getByLabel('Go to page').fill('300')
  await page.getByLabel('Go to page').press('Enter')
  check((await page.getByLabel('Current page').innerText()).startsWith('300'), 'Keyboard jump to last page failed')
  await page.getByLabel('Preview zoom').fill('180'); await page.getByRole('button',{name:'Fit width'}).click()
  await page.waitForTimeout(400)
  const fitted=await page.evaluate(()=>{const c=document.querySelector('canvas'),v=document.querySelector('.preview-scroll');return {canvas:c.getBoundingClientRect().width,viewer:v.clientWidth,scrollWidth:v.scrollWidth}})
  check(fitted.scrollWidth===fitted.viewer, 'Desktop fit-width overflow')
  await page.getByRole('button',{name:'Find character voices'}).click()
  await page.locator('.document-details summary').click()
  await page.locator('.engine-details summary').click()
  await page.locator('.diagnostics-panel summary').click()
  // Accessibility-tree names, plus optional axe-core installed outside the repository.
  const cdp=await page.context().newCDPSession(page)
  const {nodes}=await cdp.send('Accessibility.getFullAXTree')
  const controls=nodes.filter(n=>!n.ignored&&['button','spinbutton','slider','radio','DisclosureTriangle'].includes(n.role?.value)).map(n=>({role:n.role.value,name:n.name?.value}))
  check(controls.every(c=>c.name), 'Unnamed accessible control')
  let axe='Not run: set LATTE_AXE_PATH to the external axe-core bundle'
  if(process.env.LATTE_AXE_PATH) {
    await page.addScriptTag({path:process.env.LATTE_AXE_PATH})
    axe=await page.evaluate(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});return r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))})
    check(axe.length===0, `axe: ${JSON.stringify(axe)}`)
  }
  results.push({label:'accessibility-keyboard',keyboard,controls,fitted,axe})
  await page.close()
}
await browser.close()
await writeFile(`${artifacts}/evidence.json`,JSON.stringify({url,phase,results,failures},null,2))
console.log(JSON.stringify({phase,results,failures},null,2))
assert.equal(failures.length,0,failures.join('\n'))
