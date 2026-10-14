// Reuse approved local files; never downloads assets. Destination must stay outside git/public/dist.
import {readFile,copyFile,mkdir,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {createHash} from 'node:crypto'
const source=resolve(process.argv[2]||'')
const destination=resolve(process.argv[3]||'')
if(process.argv.length!==4 || destination.startsWith(resolve('.')+'/')) throw Error('Usage: node scripts/stage-private-narrator.mjs SOURCE OUTSIDE_REPOSITORY')
const files=['assets/model.onnx','assets/jasper.f32','assets/manifest.json','assets/symbols.json',
'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs','node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs','node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm','node_modules/phonemizer/dist/phonemizer.js',
'node_modules/onnxruntime-web/package.json','node_modules/phonemizer/package.json','package-lock.json','upstream/KITTEN-APACHE-LICENSE','upstream/ESPEAK-COPYING']
const expected={'assets/model.onnx':'95481626fee1ba70ce683e69c534fc7cb38433c46ce42d3abbeafb4b9f1a4123','assets/jasper.f32':'36f085b4a70855602749524990dd9793c6b69598f53284990bc7aa51289de12b'}
const manifest={privateTrial:true,modelRevision:'1ccf72b2c2048fd17efac7de2fab32d10e225084',runtime:'1.24.3',phonemizer:'1.2.1',licensing:'NOT CLEARED FOR DISTRIBUTION',files:[]}
for(const name of files){
 const bytes=await readFile(resolve(source,name)),sha256=createHash('sha256').update(bytes).digest('hex')
 if(expected[name]&&expected[name]!==sha256) throw Error('HASH_MISMATCH:'+name)
 const target=resolve(destination,name);await mkdir(dirname(target),{recursive:true});await copyFile(resolve(source,name),target)
 const copied=createHash('sha256').update(await readFile(target)).digest('hex');if(copied!==sha256)throw Error('COPY_MISMATCH')
 manifest.files.push({name,bytes:bytes.length,sha256})
}
await writeFile(resolve(destination,'private-stage-manifest.json'),JSON.stringify(manifest,null,2))
console.log(JSON.stringify({destination,files:manifest.files.length,bytes:manifest.files.reduce((n,f)=>n+f.bytes,0)},null,2))
