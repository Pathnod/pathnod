import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
// @ts-expect-error The native browser module is deliberately independent of server dependencies.
import { LatestRequest, percentage, explorer } from '../public/state.js';
class Element {
  children:Element[]=[];dataset:Record<string,string>={};attributes:Record<string,string>={};
  value:any='';max=0;disabled=false;href='';target='';rel='';className='';
  open=false;ontoggle:()=>void=()=>{};
  onclick:()=>void=()=>{};onsubmit:(event:{preventDefault():void})=>void=()=>{};
  private text='';
  set textContent(v:string){this.text=v;this.children=[];}
  get textContent():string{return this.text+this.children.map(c=>c.textContent).join('\n');}
  append(...children:Element[]){this.children.push(...children);}
  replaceChildren(...children:Element[]){this.text='';this.children=children;}
  setAttribute(k:string,v:string){this.attributes[k]=v;}
}
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));};
test('actual frontend clears active scores on stale/error and ignores late epoch responses',async()=>{
  const ids=['context','list-message','devices','previous','next','epoch','detail','detail-status','page','reload','epoch-form'];
  const elements=new Map(ids.map(id=>[id,new Element()]));const element=(id:string)=>elements.get(id)!;
  const context={network:'devnet',program:'5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd',protocolID:'01'.repeat(32)};
  const device={id:'02'.repeat(32),key:'03'.repeat(32),capabilities:2,declaredLocation:null,address:context.program};
  const published={status:'published',score:3693,label:'LOW',evaluatedAt:1000,commitment:'04'.repeat(32),
    facets:{hardware_confidence:10000,temporal_freshness:9937,witness_diversity:666,spatial_consistency:0,behavior_diversity:0,service_evidence:0},
    observers:{raw:1,groups:1},coverage:{reenrollmentRiskAvailable:false},signature:null};
  const detail=(confidence:unknown,epoch=42)=>({...context,device,epoch,policyVersion:1,state:{observers:1,paidSlots:1,root:'05'.repeat(32)},observations:[],confidence});
  let answer:(url:string)=>Promise<Response>=async()=>Response.json(detail(published));
  let detailCalls=0,signal:AbortSignal|undefined,poll!:()=>Promise<void>;
  const fetcher=async(url:string,options:{signal:AbortSignal})=>{
    if(url.startsWith('/api/devices?'))return Response.json({...context,total:1,offset:0,queryLimit:1000,currentEpoch:42,devices:[device]});
    detailCalls++;signal=options.signal;return answer(url);
  };
  const code=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace("import { LatestRequest, percentage, explorer } from './state.js';",'');
  runInNewContext(code,{LatestRequest,percentage,explorer,fetch:fetcher,document:{hidden:false,getElementById:element,createElement:()=>new Element()},setTimeout:(callback:()=>Promise<void>)=>{poll=callback;return 0;},AbortController,URL,Date,Number,Error});
  await flush();element('devices').children[0]!.onclick();await flush();assert.match(element('detail').textContent,/36.93% · Limited confidence/);
  assert.match(element('context').textContent,/real records on Solana’s test network/);
  assert.match(element('detail').textContent,/Device identity details/);
  assert.match(element('detail').textContent,/Recorded observations/);
  assert.match(element('detail').textContent,/Observer attestation/);
  assert.match(element('detail').textContent,/observing phone/);
  assert.ok(!element('detail').textContent.includes('Device authenticity'));
  assert.match(element('detail').textContent,/hardware_confidence: 10000\/10000/);
  assert.match(element('detail').textContent,/probability/);
  const identityDetails=element('detail').children[0]!.children.find(c=>c.className==='technical')!;
  assert.equal(identityDetails.open,false);identityDetails.open=true;identityDetails.ontoggle();
  answer=async()=>Response.json(detail({status:'stale'}));element('epoch-form').onsubmit({preventDefault(){}});await flush();
  assert.match(element('detail').textContent,/Report needs updating/);assert.match(element('detail').textContent,/API status: stale/);assert.ok(!element('detail').textContent.includes('36.93%'));
  assert.equal(element('detail').children[0]!.children.find(c=>c.className==='technical')!.open,true);
  let finish!: (response:Response)=>void;
  answer=()=>new Promise(resolve=>{finish=resolve;});element('epoch').value='43';element('epoch-form').onsubmit({preventDefault(){}});
  answer=async()=>Response.json(detail({status:'missing'},44));element('epoch').value='44';element('epoch-form').onsubmit({preventDefault(){}});await flush();
  finish(Response.json(detail(published,43)));await flush();assert.match(element('detail').textContent,/No report is available for this period/);assert.ok(!element('detail').textContent.includes('36.93%'));
  answer=async()=>new Response('{}',{status:503});element('epoch-form').onsubmit({preventDefault(){}});await flush();assert.match(element('detail').textContent,/couldn’t load a consistent view/);
  answer=async()=>Response.json(detail(published,44));element('epoch-form').onsubmit({preventDefault(){}});await flush();
  const visibleIdentity=element('detail').children[0];
  answer=()=>new Promise(resolve=>{finish=resolve;});const before=detailCalls;
  const pendingPoll=poll();assert.equal(detailCalls,before+1);assert.equal(element('detail').children[0],visibleIdentity);
  assert.match(element('detail-status').textContent,/Updating/);assert.match(element('detail').textContent,/36.93%/);
  await poll();assert.equal(detailCalls,before+1);assert.equal(signal!.aborted,false);
  finish(Response.json(detail(published,44)));await pendingPoll;
  assert.equal(element('detail').children[0],visibleIdentity);assert.match(element('detail-status').textContent,/Last checked/);
  for(const status of ['stale','missing','unavailable']){
    answer=async()=>Response.json(detail({status},44));await poll();
    assert.ok(!element('detail').textContent.includes('36.93%'));assert.match(element('detail').textContent,new RegExp(`API status: ${status}`));
    answer=async()=>Response.json(detail(published,44));await poll();assert.match(element('detail').textContent,/36.93%/);
  }
  answer=async()=>new Response('{}',{status:503});await poll();assert.ok(!element('detail').textContent.includes('36.93%'));
  answer=async()=>Response.json(detail(published,44));await poll();assert.match(element('detail').textContent,/36.93%/);
});
