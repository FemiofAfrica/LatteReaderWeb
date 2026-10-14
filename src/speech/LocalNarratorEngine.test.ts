import {beforeEach,describe,expect,it,vi} from 'vitest'
import {LocalNarratorEngine} from './LocalNarratorEngine'
import {planSpeechChunks} from '../domain/speechPlan'
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
const sources: {onended:(()=>void)|null; stop:ReturnType<typeof vi.fn>}[]=[]
class FakeContext {
  state='running'
  get currentTime(){return clock}
  resume(){return Promise.resolve()}
  close(){return Promise.resolve()}
  destination={}
  createBuffer(_channels:number,length:number,rate:number){return {duration:length/rate,copyToChannel:vi.fn()}}
  createBufferSource(){const source={onended:null as (()=>void)|null,buffer:null,connect:vi.fn(),disconnect:vi.fn(),stop:vi.fn(),start:(_when:number,offset:number)=>starts.push(offset)};sources.push(source);return source}
}
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve()}
beforeEach(()=>{workers=[];starts.length=0;sources.length=0;clock=0;vi.stubGlobal('Worker',FakeWorker);vi.stubGlobal('AudioContext',FakeContext)})
async function ready(){const engine=new LocalNarratorEngine(vi.fn());const pending=engine.prepare();workers[0].reply(0);await pending;return engine}
const request=(text='A short sentence. Another sentence. Third sentence. Fourth sentence.')=>({text:'',rate:1,chunks:planSpeechChunks([text],1,'document'),onPosition:vi.fn(),onError:vi.fn()})
const pcm=()=>({pcm:new Float32Array(24000).buffer,metrics:{rtf:0.2}})
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
 it('skips an indivisible refused word and keeps reading',async()=>{
  const engine=await ready();const r=request('x'.repeat(200)+' Next sentence.');engine.speak(r);await tick()
  workers[0].onmessage?.({data:{id:workers[0].requests[1].id,ok:false,error:'TOKEN_LIMIT'}});await tick()
  expect(r.onError).not.toHaveBeenCalled();expect(engine.status).not.toBe('error');engine.dispose()
 })
 it('a refused passage never halts the run (stall regression)',async()=>{
  const engine=await ready();const end=vi.fn();engine.onEnd(end);const r=request('One. Two has 12% growth. Three.');engine.speak(r);await tick()
  const w=workers[0];let i=1
  const pump=async()=>{while(i<w.requests.length){const d=w.requests[i++];const bad=String(d.text).includes('%');if(bad&&!String(d.text).includes(' '))w.onmessage?.({data:{id:d.id,ok:false,error:'UNSUPPORTED_TEXT'}});else if(bad)w.onmessage?.({data:{id:d.id,ok:false,error:'UNSUPPORTED_TEXT'}});else w.reply(i-1,pcm());await tick()}}
  for(let k=0;k<20;k++){await pump();const s=sources.find(x=>x.onended&&!(x as any).done);if(s){(s as any).done=true;s.onended!();await tick()}}
  expect(r.onError).not.toHaveBeenCalled();expect(engine.status).toBe('ready');expect(end).toHaveBeenCalledTimes(1);expect(engine.stats.skipped).toBeGreaterThan(0);engine.dispose()
 })
})
