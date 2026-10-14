import {beforeEach,describe,expect,it,vi} from 'vitest'
import {LocalNarratorEngine} from './LocalNarratorEngine'
import {planSpeechChunks} from '../domain/speechPlan'

vi.mock('../diagnostics/diagnostics',()=>({recordEvent:vi.fn()}))

let workers: FakeWorker[]=[]
class FakeWorker {
  onmessage: ((event:{data:unknown})=>void)|null=null
  onerror: (()=>void)|null=null
  requests: Record<string,unknown>[]=[]
  terminated=false
  constructor(){workers.push(this)}
  postMessage(d:Record<string,unknown>){this.requests.push(d)}
  terminate(){this.terminated=true}
  reply(index:number,extra:Record<string,unknown>={}){const d=this.requests[index];this.onmessage?.({data:{id:d.id,ok:true,...extra}})}
}
let clock=0
const starts:number[]=[]
const sources: {onended:(()=>void)|null; stop:ReturnType<typeof vi.fn>; done?:boolean}[]=[]
class FakeContext {
  state='running'
  get currentTime(){return clock}
  resume(){return Promise.resolve()}
  close(){return Promise.resolve()}
  destination={}
  createBuffer(_channels:number,length:number,rate:number){return {duration:length/rate,copyToChannel:vi.fn()}}
  createBufferSource(){const source={onended:null as (()=>void)|null,buffer:null,connect:vi.fn(),disconnect:vi.fn(),stop:vi.fn(),start:(_when:number,offset:number)=>starts.push(offset)};sources.push(source);return source}
}
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
const notices: unknown[]=[]
beforeEach(()=>{
  workers=[];starts.length=0;sources.length=0;notices.length=0;clock=0
  vi.stubGlobal('Worker',FakeWorker);vi.stubGlobal('AudioContext',FakeContext)
  window.addEventListener('latte-local-notice',e=>notices.push((e as CustomEvent).detail))
})
async function ready(){const engine=new LocalNarratorEngine(vi.fn());const pending=engine.prepare();workers[0].reply(0);await pending;return engine}
const request=(text='A short sentence. Another sentence. Third sentence. Fourth sentence.')=>({text:'',rate:1,chunks:planSpeechChunks([text],1,'document'),onPosition:vi.fn(),onPage:vi.fn(),onError:vi.fn()})
const pcm=(dropped=0)=>({pcm:new Float32Array(24000).buffer,metrics:{rtf:0.2,dropped,contained:dropped>0}})

describe('private PCM lifecycle (control mocks, not audible evidence)',()=>{
 it('does not prepare until explicit consent and cancels preparation',async()=>{
  const engine=new LocalNarratorEngine(vi.fn());expect(workers).toHaveLength(0)
  const preparing=engine.prepare();engine.dispose();await preparing
  expect(workers[0].terminated).toBe(true);expect(engine.available).toBe(false)
 })
 it('pauses at audio-clock offset and resumes without synthesis',async()=>{
  const engine=await ready();engine.speak(request());await tick();workers[0].reply(1,pcm());await tick()
  clock=.4;engine.pause();const count=workers[0].requests.length
  engine.resume();await tick();expect(starts).toEqual([0,.4]);expect(workers[0].requests).toHaveLength(count)
  engine.dispose()
 })
 it('ignores late inference after Stop and freezes source during buffering',async()=>{
  const engine=await ready();const r=request();engine.speak(r);await tick();expect(r.onPosition).not.toHaveBeenCalled()
  engine.stop();workers[0].reply(1,pcm());await tick();expect(starts).toHaveLength(0);expect(r.onPosition).not.toHaveBeenCalled();engine.dispose()
 })
 it('holds at most current plus two ready and emits one end after drain',async()=>{
  const engine=await ready();const end=vi.fn();engine.onEnd(end);engine.speak(request());await tick()
  for(let i=1;i<=3;i++){workers[0].reply(i,pcm());await tick()}
  expect(workers[0].requests).toHaveLength(4);expect(engine.stats.maxBufferedSeconds).toBe(3)
  sources[0].onended?.();await tick();workers[0].reply(4,pcm());await tick()
  for(let i=1;i<=3;i++){sources[i].onended?.();await tick()}
  expect(end).toHaveBeenCalledTimes(1);expect(engine.status).toBe('ready');engine.dispose()
 })
 it('splits overbudget text only at word boundaries with exact coverage',async()=>{
  const engine=await ready();const text='longword '.repeat(24);engine.speak(request(text));await tick()
  workers[0].onmessage?.({data:{id:workers[0].requests[1].id,ok:false,error:'TOKEN_LIMIT'}});await tick()
  const first=String(workers[0].requests[2].text);workers[0].reply(2,pcm());await tick()
  expect(first+workers[0].requests[3].text).toBe(text.trim());expect(first.endsWith(' ')).toBe(true);engine.dispose()
 })
 it('skips an indivisible refused word, advances the position, and keeps reading the next sentence',async()=>{
  const engine=await ready();const end=vi.fn();engine.onEnd(end)
  // Two planned parts: an indivisible over-long word, then a readable sentence. The first
  // has no word boundary so TOKEN_LIMIT cannot be answered by splitting.
  const r=request('x'.repeat(200)+'. Next sentence.');engine.speak(r);await tick()
  // Refuse every request that is still the indivisible word (split may re-queue halves
  // that are themselves indivisible and still refuse).
  for(let round=0;round<6;round++){
    for(let i=1;i<workers[0].requests.length;i++){
      const d=workers[0].requests[i] as {id:number;text?:string;answered?:boolean}
      if(d.answered) continue
      d.answered=true
      if(/^x+$/.test(String(d.text).trim())||String(d.text).includes('x'.repeat(20))){
        workers[0].onmessage?.({data:{id:d.id,ok:false,error:'TOKEN_LIMIT'}})
      } else {
        workers[0].reply(i,pcm())
      }
      await tick()
    }
    for(const s of sources){if(s.onended&&!s.done){s.done=true;s.onended();await tick()}}
  }
  expect(r.onError).not.toHaveBeenCalled()
  expect(engine.status).toBe('ready')
  expect(engine.stats.skipped).toBeGreaterThan(0)
  expect(r.onPosition).toHaveBeenCalled()
  expect(notices.length).toBeGreaterThan(0)
  expect(end).toHaveBeenCalledTimes(1)
  engine.dispose()
 })
 it('a refused passage never halts the run (stall regression)',async()=>{
  const engine=await ready();const end=vi.fn();engine.onEnd(end)
  // One clean sentence, one that the frontend would refuse as a whole, one clean sentence.
  const r=request('One. Two has 12% growth. Three.');engine.speak(r);await tick()
  const w=workers[0]
  // Answer every outstanding request: refuse any part that still contains '%', accept the rest.
  for(let round=0;round<12;round++){
    const pending=w.requests.slice(1).filter((_,i)=>!((w as any)._answered)?.has(i+1))
    ;(w as any)._answered??=new Set<number>()
    for(let i=1;i<w.requests.length;i++){
      if((w as any)._answered.has(i)) continue
      const text=String(w.requests[i].text)
      if(text.includes('%')) w.onmessage?.({data:{id:w.requests[i].id,ok:false,error:'UNSUPPORTED_TEXT'}})
      else w.reply(i,pcm())
      ;(w as any)._answered.add(i)
      await tick()
    }
    for(const s of sources){if(s.onended&&!s.done){s.done=true;s.onended();await tick()}}
  }
  expect(r.onError).not.toHaveBeenCalled()
  expect(engine.status).toBe('ready')
  expect(end).toHaveBeenCalledTimes(1)
  expect(engine.stats.skipped+engine.stats.generated).toBeGreaterThan(1)
  engine.dispose()
 })
 it('a mid-run generation failure does not halt playback of the remaining document',async()=>{
  const engine=await ready();const end=vi.fn();engine.onEnd(end)
  const r=request('First sentence. Second sentence. Third sentence.');engine.speak(r);await tick()
  // First part succeeds.
  workers[0].reply(1,pcm());await tick()
  // Second part fails with a generation error that cannot be split further after one attempt.
  // Force the failure on every remaining request for that span by refusing with INFERENCE_FAILED.
  const failId=workers[0].requests[2]?.id
  workers[0].onmessage?.({data:{id:failId,ok:false,error:'INFERENCE_FAILED'}});await tick()
  // Whatever remains (split halves or the next sentence) must still be answered.
  for(let i=3;i<workers[0].requests.length;i++){workers[0].reply(i,pcm());await tick()}
  for(const s of sources){if(s.onended&&!s.done){s.done=true;s.onended();await tick()}}
  // Drain anything the onended callbacks queued.
  for(let i=0;i<8;i++){
    for(let j=1;j<workers[0].requests.length;j++){
      const d=workers[0].requests[j]
      if(!(d as {answered?:boolean}).answered){(d as {answered?:boolean}).answered=true;workers[0].reply(j,pcm());await tick()}
    }
    for(const s of sources){if(s.onended&&!s.done){s.done=true;s.onended();await tick()}}
  }
  expect(r.onError).not.toHaveBeenCalled()
  expect(end).toHaveBeenCalledTimes(1)
  expect(engine.status).toBe('ready')
  expect(engine.stats.generated).toBeGreaterThan(0)
  engine.dispose()
 })
 it('a contained part with a dropped unit raises the plain notice without stopping',async()=>{
  const engine=await ready();const end=vi.fn();engine.onEnd(end)
  const r=request('One short sentence.');engine.speak(r);await tick()
  workers[0].reply(1,pcm(1));await tick()
  sources[0].onended?.();await tick()
  expect(notices.some((n:any)=>n.dropped===1)).toBe(true)
  expect(r.onError).not.toHaveBeenCalled()
  expect(end).toHaveBeenCalledTimes(1)
  engine.dispose()
 })
})
