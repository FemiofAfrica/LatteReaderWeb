import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
const out=process.env.LATTE_EVIDENCE;await mkdir(out,{recursive:true});
const browser=await chromium.launch();const states=[];
for(const width of [1440,504,390,320,960]){const page=await browser.newPage({viewport:{width,height:width===960?540:900}});await page.goto(process.env.LATTE_READER_URL);await page.waitForTimeout(800);
const capture=async(name)=>{await page.evaluate(()=>document.fonts.ready);states.push({width,name,text:await page.locator('body').innerText(),prose:await page.locator('p').evaluateAll(es=>es.filter(e=>{const r=e.getBoundingClientRect();return r.width>1&&r.height>1&&getComputedStyle(e).visibility!=='hidden'}).map(e=>({text:e.textContent.trim(),region:e.closest('.local-narrator-controls')?'narrator':'other'}))),controls:await page.locator('button,a,select,input,summary').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent,label:e.getAttribute('aria-label'),x:r.x,y:r.y,w:r.width,h:r.height,visible:r.width>0&&r.height>0}}))});await page.screenshot({path:`${out}/${width}-${name}.png`})};
await capture('empty');await page.locator('input[type=file]').setInputFiles('tests/fixtures/reading-quality.pdf');await page.waitForFunction(()=>document.querySelector('canvas'));await page.waitForTimeout(1500);await capture('ready');
if(width<781||width===960)await page.getByRole('tab',{name:'Voices',exact:true}).click();await page.locator('.local-narrator-controls select').selectOption('local');await page.locator('details').evaluateAll(es=>es.forEach(e=>e.open=true));await capture('voices-expanded');await page.close();}
await writeFile(`${out}/rendered.json`,JSON.stringify(states,null,2));await browser.close();
