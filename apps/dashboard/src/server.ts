import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Connection } from '@solana/web3.js';
import { configFromEnv } from './config.ts';
import { DashboardService } from './service.ts';

const assets = new URL('../public/',import.meta.url);
export function createDashboardServer(service: DashboardService) {
  let active=0;
  return createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json=(code:number,value:unknown)=>{res.statusCode=code;res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
    if(req.method!=='GET'){res.setHeader('allow','GET');json(405,{error:'read_only'});return;}
    const url=new URL(req.url??'/','http://dashboard.invalid');
    const allowed:Record<string,string>={'/':'index.html','/app.js':'app.js','/state.js':'state.js','/style.css':'style.css','/details.css':'details.css','/mark.png':'mark.png'};
    if(allowed[url.pathname]&&!url.search){
      try{res.setHeader('content-type',url.pathname.endsWith('.png')?'image/png':url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(new URL(allowed[url.pathname]!,assets)));}
      catch{json(503,{error:'asset_unavailable'});}return;
    }
    if(active>=4){json(429,{error:'dashboard_busy'});return;}
    active++;
    try{
      if(url.pathname==='/api/devices'){
        if([...url.searchParams.keys()].some(k=>k!=='offset')||url.searchParams.getAll('offset').length>1)throw Error('invalid_input');
        const text=url.searchParams.get('offset')??'0';
        if(!/^(0|[1-9][0-9]{0,3})$/.test(text)||Number(text)>1000)throw Error('invalid_input');
        json(200,await service.devices(Number(text)));
      }else if(/^\/api\/devices\/[a-f0-9]{64}$/.test(url.pathname)){
        const epoch=url.searchParams.get('epoch');
        if([...url.searchParams.keys()].some(k=>k!=='epoch')||url.searchParams.getAll('epoch').length!==1||!epoch||!/^(0|[1-9][0-9]{0,9})$/.test(epoch)||Number(epoch)>0xffffffff)throw Error('invalid_input');
        const detail=await service.detail(url.pathname.split('/')[3]!,Number(epoch));json(detail?200:404,detail??{error:'device_unknown'});
      }else json(404,{error:'not_found'});
    }catch(error){json(error instanceof Error&&error.message==='invalid_input'?400:503,{error:error instanceof Error&&error.message==='invalid_input'?'invalid_input':'deployment_or_data_unavailable'});}
    finally{active--;}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=configFromEnv(process.env);
  const connection=new Connection(config.rpc.href,{commitment:'finalized',disableRetryOnRateLimit:true,
    fetch:(input,init)=>fetch(input,{...init,redirect:'error',signal:AbortSignal.timeout(15000)})});
  const service=new DashboardService(config,connection);
  await service.target();
  createDashboardServer(service).listen(config.port,config.host,()=>console.log(`Read-only dashboard: http://${config.host}:${config.port} (${config.network})`));
}
