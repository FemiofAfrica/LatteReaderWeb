// Explicit private loopback server. Model/runtime remain outside the repository.
import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
const root=resolve(process.env.LATTE_DIST || 'dist');
const runtime=process.env.LATTE_NARRATOR_ASSETS;
if(!runtime) throw Error('Set LATTE_NARRATOR_ASSETS to the approved feasibility directory');
const assets=resolve(runtime);
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.wav':'audio/wav','.pdf':'application/pdf','.svg':'image/svg+xml','.png':'image/png'};
http.createServer(async(req,res)=>{
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')) { res.writeHead(403).end(); return; }
  if(req.method!=='GET'&&req.method!=='HEAD') {res.writeHead(405).end();return;}
  try {
    const path=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    const privateRoute=path.startsWith('/__narrator/');
    const base=privateRoute?assets:root;
    let target=resolve(base,'.'+(privateRoute?path.slice('/__narrator'.length):path));
    if(target!==base&&!target.startsWith(base+sep)) {res.writeHead(403).end();return;}
    if(path==='/__narrator/worker.mjs') target=resolve('scripts/private-narrator-worker.mjs');
    else if((await stat(target)).isDirectory()) target=resolve(target,'index.html');
    let data=await readFile(target);
    if(target===resolve(root,'index.html')) data=Buffer.from(data.toString().replace('<head>','<head><script>window.__LATTE_PRIVATE_NARRATOR__=true</script>'));
    res.writeHead(200,{'Content-Type':mime[extname(target)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:data);
  }catch {res.writeHead(404).end('Not found');}
}).listen(Number(process.env.PORT||4187),'127.0.0.1',()=>console.log('Private narrator loopback ready'));
