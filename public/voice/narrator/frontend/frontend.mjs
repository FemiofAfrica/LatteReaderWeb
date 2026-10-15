// Modified Misaki-derived dictionary+morphology+learned BART browser frontend. Not full POS pipeline.
// Derived lookup/context rules and data: hexgrad/misaki fba1236, Apache-2.0.
// Number normalizer is independently implemented here, not copied from num2words.
const expansions={A:'eɪ',I:'aɪ',O:'oʊ',W:'aʊ',Y:'ɔɪ',Q:'əʊ','ʤ':'dʒ','ʧ':'tʃ','ᵊ':'ə'};
export const expand=ps=>[...ps].map(c=>expansions[c]??c).join('');
const small='zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const tens='zero ten twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
export function cardinal(n){if(!Number.isSafeInteger(n)||Math.abs(n)>=1e12)throw Error('Number range: integers below one trillion only');if(n<0)return 'minus '+cardinal(-n);if(n<20)return small[n];if(n<100)return tens[Math.floor(n/10)]+(n%10?' '+small[n%10]:'');for(const [v,name] of [[1e9,'billion'],[1e6,'million'],[1e3,'thousand'],[100,'hundred']])if(n>=v)return cardinal(Math.floor(n/v))+' '+name+(n%v?' '+cardinal(n%v):'');}
const ords={one:'first',two:'second',three:'third',five:'fifth',eight:'eighth',nine:'ninth',twelve:'twelfth'};
export function ordinal(n){const a=cardinal(n).split(' '),w=a.pop();a.push(ords[w]??(w.endsWith('y')?w.slice(0,-1)+'ieth':w+'th'));return a.join(' ');}
function year(n){return n>=2000&&n<=2009?'two thousand'+(n%100?' '+cardinal(n%100):''):Math.floor(n/100)>0?cardinal(Math.floor(n/100))+(n%100===0?' hundred':n%100<10?' oh '+cardinal(n%100):' '+cardinal(n%100)):cardinal(n);}
const months=new Set('january february march april may june july august september october november december'.split(' '));
const abbr={'dr.':'doctor','mr.':'mister','mrs.':'missus','ms.':'miz','prof.':'professor','etc.':'et cetera','a.m.':'A M','p.m.':'P M'};
const scanner=/\s+|[$£€]-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|\d{1,2}:\d{2}|(?:[A-Za-z]\.){2,}|(?:Dr|Mr|Mrs|Ms|Prof|etc)\.|-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:st|nd|rd|th)?|[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*(?:['’](?![\p{L}\p{M}]))?|[;:,.!?¡¿—–…"«»“”(){}\[\]-]|./guy;
// The product loader supplies length-and-hash-verified data; no implicit fetches.
export function lexicon(gold,silver,bart){return {gold,silver,bart};}
export function prepare(text,lex,symbols,overrides={}){
 if(/\d(?:,\d{1,2}(?!\d)|\/\d|[eE][+-]?\d)|\d+\.\d+\.\d|\d+[:]\d+(?:[:]\d+)|\d+[A-Za-z]+\d/u.test(text))throw Error('UNSUPPORTED_TEXT');
 const units=[],unknown=[],ambiguities=[];scanner.lastIndex=0;let m;
 while((m=scanner.exec(text))){const raw=m[0],u={start:m.index,end:scanner.lastIndex,raw,kind:'lexical',words:[],phones:[],choices:[]};units.push(u);if(/^\s+$/u.test(raw)){u.kind='whitespace';continue;}
 const w=raw.normalize('NFKC').replace(/’/g,"'");let spoken;
 try{if(abbr[w.toLowerCase()]){spoken=abbr[w.toLowerCase()];u.kind='abbreviation';if(w.toLowerCase()==='dr.')ambiguities.push({start:u.start,word:raw,reason:'Dr. expanded as doctor, not drive; no general semantic disambiguation'});}
 else if(/^(?:[A-Za-z]\.){2,}$/.test(w)){spoken=w.replaceAll('.','').toUpperCase().split('').join(' ');u.kind='initialism';}
 else if(/^[$£€]/.test(w)){const cur={'$':['dollar','cent'],'£':['pound','penny'],'€':['euro','cent']}[w[0]],parts=w.slice(1).replaceAll(',','').split('.'),amount=Number(parts[0]),cents=Number((parts[1]??'').padEnd(2,'0'));if(parts[0].startsWith('-'))throw Error('Negative currency not supported');spoken=cardinal(amount)+' '+cur[0]+(amount!==1?'s':'')+(cents?' and '+cardinal(cents)+' '+(cur[1]==='penny'&&cents!==1?'pence':cur[1]+(cents!==1?'s':'')):'');u.kind='currency';}
 else if(/^\d{1,2}:\d{2}$/.test(w)){const [h,min]=w.split(':').map(Number);if(h>23||min>59)throw Error('invalid time');spoken=cardinal(h)+(min===0?' O clock':min<10?' oh '+cardinal(min):' '+cardinal(min));u.kind='time';}
 else if(/^-?\d/.test(w)){const v=w.replaceAll(',',''),suffix=v.match(/(st|nd|rd|th)$/)?.[0],n=Number(v.replace(/(st|nd|rd|th)$/,''));const previous=units.slice(0,-1).filter(x=>x.kind!=='whitespace').at(-1)?.raw.toLowerCase();if(suffix||(months.has(previous)&&Number.isInteger(n)&&n>=1&&n<=31))spoken=ordinal(n);else if(v.includes('.')){const [whole,frac]=v.split('.');spoken=(whole.startsWith('-')?'minus ':'')+cardinal(Math.abs(Number(whole)))+' point '+[...frac].map(x=>small[Number(x)]).join(' ');}else spoken=v.length===4?year(n):cardinal(n);u.kind='number';}
 else if(/^[;:,.!?¡¿—–…"«»“”(){}\[\]-]$/u.test(w)){u.kind='punctuation';u.phones=[w.replace(/[“”]/g,'"').replace(/[–-]/g,'—')];continue;}
 else if(/^[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*'?$/.test(w)||/^[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*'?$/u.test(w))spoken=w;
 else throw Error('unsupported source character');
 u.spoken=spoken;u.words=spoken.split(/\s+/);
 }catch(e){u.error=e.message;unknown.push({start:u.start,end:u.end,raw,reason:e.message});}
 }
 // Backward context for articles derives from upstream TokenContext/get_special_case.
 let futureVowel=null;
 for(const u of [...units].reverse()){
 if(u.kind==='whitespace')continue;if(u.kind==='punctuation'){if(!/["«»]/.test(u.phones[0]))futureVowel=null;continue;}
 for(const word of [...u.words].reverse()){
 let entry,ps,origin,key=word;const lower=word.toLowerCase();
 if(Object.hasOwn(overrides,lower)){ps=overrides[lower];origin='explicit-user-override';}
 else {if(Object.hasOwn(lex.gold,key)){entry=lex.gold[key];origin='gold';}else if(Object.hasOwn(lex.gold,lower)){entry=lex.gold[lower];origin='gold';key=lower;}else if(Object.hasOwn(lex.silver,key)){entry=lex.silver[key];origin='silver';}else if(Object.hasOwn(lex.silver,lower)){entry=lex.silver[lower];origin='silver';key=lower;}
 if(typeof entry==='string')ps=entry;
 else if(entry&&typeof entry==='object'){ps=entry.DEFAULT;const variants=Object.entries(entry).filter(([,v])=>v!==null);if(new Set(variants.map(([,v])=>v)).size>1)ambiguities.push({start:u.start,word,reason:'No spaCy POS model in this prototype; DEFAULT selected',variants});}
 // General morphology before learned fallback; no vocabulary patches.
 if(!ps){const morph=morphology(lower,lex);if(morph){ps=morph.ps;origin='morphology:'+morph.rule;}}
 if(!ps){try{const canonical=word.normalize('NFD').replace(/\p{M}/gu,'');const prediction=lex.bart.predict(canonical);ps=prediction.phones;origin='learned BART'+(canonical!==word?': Latin diacritic transliteration':'');u.fallback??=[];u.fallback.unshift({...prediction,steps:undefined,sourceWord:word});}catch(e){u.fallbackErrors??=[];u.fallbackErrors.push(e.message);}}
 if(lower==='the'){ps=futureVowel===true?'ði':'ðə';origin='Misaki-derived future-vowel article';}else if(lower==='a'&&!['abbreviation','initialism'].includes(u.kind)){ps='ə';origin='article heuristic (not upstream DT tagging)';}else if(lower==='to'){ps=futureVowel===null?(typeof entry==='string'?entry:'tu'):futureVowel?'tʊ':'tə';origin='Misaki-derived future-vowel to';}
 }
 if(typeof ps!=='string'||!ps){unknown.push({start:u.start,end:u.end,raw:u.raw,word,reason:u.fallbackErrors?.join('; ')??'No pronunciation'});u.phones.unshift('');continue;}
 const ipa=expand(ps);u.phones.unshift(ipa);u.choices.unshift({word,key,origin,compact:ps,ipa});const first=[...ps].find(c=>/[AIOWYaiuæɑɔəɛɜɪʊʌᵻbdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ]/u.test(c));futureVowel=first?/[AIOWYaiuæɑɔəɛɜɪʊʌᵻ]/u.test(first):futureVowel;
 }
 }
 const ipa=units.filter(u=>u.kind!=='whitespace').map(u=>u.phones.join(' ')).join(' ');const clean=(ipa.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu)??[]).join(' ');const unsupported=[...new Set([...clean].filter(c=>symbols[c]===undefined))];const ids=unsupported.length?[]:[0,...[...clean].map(c=>symbols[c]),10,0];
 const allSourceCovered=units.map(u=>u.raw).join('')===text;const lexical=units.filter(u=>!['whitespace','punctuation'].includes(u.kind));const failed=new Set(unknown.map(x=>x.start));return {text,units,unknown,ambiguities,ipa,clean,ids,unsupported,allSourceCovered,sourceUnits:lexical.length,coveredUnits:lexical.filter(u=>!failed.has(u.start)).length,styleRow:Math.min([...text].length,399),ok:allSourceCovered&&unknown.length===0&&unsupported.length===0&&ids.length<=500,tokenLimitExceeded:ids.length>500};
}

function lookup(w,lex){const e=lex.gold[w]??lex.silver[w];return typeof e==='string'?e:e?.DEFAULT;}
const taus='AIOWYiuæɑɔəɛɜɪʊʌᵻ';
function suffix(ps,kind){if(kind==='s')return ps+(/[ptkfθ]$/.test(ps)?'s':/[szʃʒʧʤ]$/.test(ps)?'ᵻz':'z');if(kind==='ing')return (ps.endsWith('t')&&taus.includes(ps.at(-2))?ps.slice(0,-1)+'ɾ':ps)+'ɪŋ';if(/[pkfθʃsʧ]$/.test(ps))return ps+'t';if(ps.endsWith('d'))return ps+'ᵻd';if(!ps.endsWith('t'))return ps+'d';return (taus.includes(ps.at(-2))?ps.slice(0,-1)+'ɾ':ps)+'ᵻd';}
function morphology(w,lex){let candidates=[];if(w.endsWith("s'")){const ps=lookup(w.slice(0,-1),lex);if(ps)return {ps,rule:'plural possessive'};w=w.slice(0,-1);}if(w.endsWith("'s")){const stem=w.slice(0,-2),ps=lookup(stem,lex);if(ps)return {ps:suffix(ps,'s'),rule:'possessive'};try{const p=lex.bart.predict(stem.normalize('NFD').replace(/\p{M}/gu,''));return {ps:suffix(p.phones,'s'),rule:'learned-stem possessive'};}catch{}}
 if(w.endsWith('s')&&w.length>=3){if(!w.endsWith('ss'))candidates.push([w.slice(0,-1),'s']);if(w.endsWith('es')&&!w.endsWith('ies'))candidates.push([w.slice(0,-2),'s']);if(w.endsWith('ies'))candidates.push([w.slice(0,-3)+'y','s']);}
 if(w.endsWith('d')&&w.length>=4){if(!w.endsWith('dd'))candidates.push([w.slice(0,-1),'ed']);if(w.endsWith('ed')&&!w.endsWith('eed')){candidates.push([w.slice(0,-2),'ed']);if(/([bcdgklmnprstvxz])\1ed$/.test(w))candidates.push([w.slice(0,-3),'ed']);if(w.endsWith('ied'))candidates.push([w.slice(0,-3)+'y','ed']);}}
 if(w.endsWith('ing')&&w.length>=5){candidates.push([w.slice(0,-3),'ing'],[w.slice(0,-3)+'e','ing']);if(/([bcdgklmnprstvxz])\1ing$|cking$/.test(w))candidates.push([w.slice(0,-4),'ing']);}
 for(const [stem,k] of candidates){const ps=lookup(stem,lex);if(ps)return {ps:suffix(ps,k),rule:k+':'+stem};}return null;}
