// Reuse the approved graph/runtime unchanged. Stage only the accepted frontend.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='public/voice/narrator/';const pins=JSON.parse(await readFile('src/speech/local/narratorPins.json'));
const names=['frontend.mjs','bart.mjs','bart-config.json','model.safetensors','us_gold.json','us_silver.json'];
const files=[];for(const name of names){const b=await readFile(root+'frontend/'+name);files.push({path:'frontend/'+name,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});}
const expected={'model.safetensors':'dc4a02e62d4fcb4bb4097ecf00db89b8e1a12a549a52ab6adfbba220b80a55c5','us_gold.json':'dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f','us_silver.json':'de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475'};
for(const f of files)if(expected[f.path.split('/').at(-1)]&&expected[f.path.split('/').at(-1)]!==f.sha256)throw Error('source mismatch');
pins.phonemizer={component:'Misaki-derived English frontend with learned BART fallback',project:'hexgrad/misaki',revision:'fba1236595f2d2bf21d414ba6e57d25256afada3',version:'0.9.4',licence:'Apache-2.0',fallback:{project:'PeterReid/graphemes_to_phonemes_en_us',revision:'a5631b285d18d59483c32c0c3379cb9fac924f4b'},noticeIndex:'../notices/index.html',files};
pins.transfer.entries=pins.transfer.entries.filter(e=>!e.path.includes('espeak')&&!e.path.startsWith('frontend/')).concat(files.map(f=>({...f,why:'Pinned English pronunciation frontend, dictionaries and learned fallback'})));
pins.transfer.bytes=pins.transfer.entries.reduce((n,e)=>n+e.bytes,0);
for(const f of pins.transfer.entries)if((await stat(root+f.path)).size!==f.bytes||f.bytes>26214400)throw Error('asset size');
const json=JSON.stringify(pins,null,2)+'\n';await writeFile(root+'manifest.json',json);await writeFile('src/speech/local/narratorPins.json',json);console.log(JSON.stringify({bytes:pins.transfer.bytes,files:pins.transfer.entries.length,frontend:files},null,2));
