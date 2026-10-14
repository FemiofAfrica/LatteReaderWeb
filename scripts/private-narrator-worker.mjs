// Served only by private-narrator-preview.mjs, never copied to public/dist.
import * as ort from './node_modules/onnxruntime-web/dist/ort.wasm.min.mjs';
import { phonemize } from './node_modules/phonemizer/dist/phonemizer.js';
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('./node_modules/onnxruntime-web/dist/', import.meta.url).href;
let session, voice, symbols;
async function get(path, hash) {
  const response = await fetch(path, {credentials:'omit'});
  if (!response.ok) throw Error('ASSET_UNAVAILABLE');
  const b = await response.arrayBuffer();
  if (hash) {
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');
    if (h !== hash) throw Error('HASH_MISMATCH');
  }
  return b;
}
function tokenize(ipa) { return (ipa.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu)||[]).join(' '); }
async function inputs(original) {
  const text=original.replace(/[“”]/g,'"').replace(/[‘’]/g,"'");
  const marks=/[;:!?¡¿—…"«»“”(){}\[\]]|(?<![0-9])[,.]|[,.](?![0-9])/gu;
  let ipa='',at=0;
  for (const match of text.matchAll(marks)) {
    const segment=text.slice(at,match.index);
    if(segment.trim()) ipa+=(await phonemize(segment,'en-us')).join(' ');
    ipa+=match[0]+' '; at=match.index+match[0].length;
  }
  const tail=text.slice(at);
  if(tail.trim()) ipa+=(await phonemize(tail,'en-us')).join(' ');
  const clean=tokenize(ipa);
  if([...clean].some(c=>symbols[c]===undefined)) throw Error('UNKNOWN_PHONEMES');
  const ids=[0,...[...clean].map(c=>symbols[c]),10,0];
  if(ids.length>500) throw Error('TOKEN_LIMIT');
  return {ids,styleRow:Math.min([...original].length,399)};
}
self.onmessage=async({data:d})=>{
  try {
    if(d.op==='init') {
      const start=performance.now();
      const manifest=await(await fetch('./assets/manifest.json',{credentials:'omit'})).json();
      symbols=await(await fetch('./assets/symbols.json',{credentials:'omit'})).json();
      voice=new Float32Array(await get('./assets/jasper.f32',manifest.derived_voice.sha256));
      if(voice.length!==400*256) throw Error('INVALID_VOICE');
      session=await ort.InferenceSession.create(await get('./assets/model.onnx',manifest.hashes['model.onnx']),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
      self.postMessage({id:d.id,ok:true,initMs:performance.now()-start,threads:1});
    } else if(d.op==='generate') {
      const start=performance.now(); const i=await inputs(d.text);
      const out=await session.run({input_ids:new ort.Tensor('int64',BigInt64Array.from(i.ids,x=>BigInt(x)),[1,i.ids.length]),style:new ort.Tensor('float32',voice.slice(i.styleRow*256,(i.styleRow+1)*256),[1,256]),speed:new ort.Tensor('float32',new Float32Array([d.speed||1]),[1])});
      try {
        const pcm=Float32Array.from(out.waveform.data);
        if(out.waveform.dims.length!==1||!pcm.length||!pcm.every(Number.isFinite)) throw Error('INVALID_PCM');
        const generateMs=performance.now()-start;
        self.postMessage({id:d.id,ok:true,pcm:pcm.buffer,metrics:{generateMs,audioSeconds:pcm.length/24000,rtf:generateMs/(pcm.length/24),tokens:i.ids.length,styleRow:i.styleRow,trimSamples:0}},[pcm.buffer]);
      } finally { for(const t of Object.values(out)) t.dispose(); }
    }
  } catch(e) {
    const allowed=['ASSET_UNAVAILABLE','HASH_MISMATCH','INVALID_VOICE','UNKNOWN_PHONEMES','TOKEN_LIMIT','INVALID_PCM'];
    self.postMessage({id:d.id,ok:false,error:allowed.includes(e.message)?e.message:'INFERENCE_FAILED'});
  }
};
