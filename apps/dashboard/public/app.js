import { LatestRequest, percentage, explorer } from './state.js';
import { declaredAreaMap } from './map.js';
const $ = id => document.getElementById(id);
const listRequest = new LatestRequest(), detailRequest = new LatestRequest();
const expandedDetails = new Map();
let offset=0,total=0,selected=null,network=null;
let detailPending=false,viewKey=null,lastResponse=null,lastChecked=null;
function node(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
function item(label,value){const div=node('div',undefined,'metric');div.append(node('span',label,'label'),node('strong',String(value)));return div;}
function details(label,...children){const section=node('details',undefined,'technical');const key=label==='Data source details'?label:`${selected}/${$('epoch').value}/${label}`;section.open=expandedDetails.get(key)===true;section.ontoggle=()=>expandedDetails.set(key,section.open);section.append(node('summary',label),...children);return section;}
function link(kind,address,label){const url=explorer(network,kind,address);if(!url)return node('code',address);const a=node('a',label??address);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
async function get(url,signal){const response=await fetch(url,{signal,cache:'no-store'});if(!response.ok)throw Error('Data unavailable');return response.json();}
function bindContext(data){network=data.network;$('context').replaceChildren(node('span',network==='devnet'?'SOLANA DEVNET':'LOCAL TEST NETWORK','network'),node('span','Live blockchain data · Confirmed records'),node('p',network==='devnet'?'These are real records on Solana’s test network, not production assets.':'These records come from a local test validator.','note'),details('Data source details',node('p','Read-only access. Records are read at Solana’s finalized confirmation level.','note'),node('code',`Program: ${data.program}`),node('code',`Protocol ID: ${data.protocolID}`),node('p',`Global registry scan limit: ${data.queryLimit} accounts. Larger scans return an error, not a partial list.`,'note')));}
async function loadList(){
 const request=listRequest.begin();$('list-message').textContent='Loading registered devices…';$('devices').replaceChildren();$('previous').disabled=true;$('next').disabled=true;
 try{const data=await get(`/api/devices?offset=${offset}`,request.signal);if(!listRequest.current(request))return;bindContext(data);total=data.total;
  if(!$('epoch').value)$('epoch').value=data.currentEpoch;
  $('list-message').textContent=total?`${total} registered ${total===1?'device':'devices'} in this network protocol.`:'No devices have been registered in this network protocol yet.';
  for(const device of data.devices){const button=node('button',undefined,'device');button.append(node('strong',`Device · ${device.id.slice(0,12)}…`),node('span',device.declaredLocation?`Declared area: ${device.declaredLocation}`:'Location not provided'));button.dataset.id=device.id;button.setAttribute('aria-pressed',String(selected===device.id));button.onclick=()=>{selected=device.id;for(const b of $('devices').children)b.setAttribute('aria-pressed',String(b.dataset.id===selected));loadDetail();};$('devices').append(button);}
  $('page').textContent=total?`${offset+1}–${Math.min(offset+25,total)} / ${total}`:'0 devices';$('previous').disabled=offset===0;$('next').disabled=offset+25>=total;
 }catch(error){if(!listRequest.current(request)||error.name==='AbortError')return;$('list-message').textContent='We couldn’t load the devices or verify the data source. Select Refresh to try again. No sample data is shown.';$('context').textContent='Data source unavailable';detailRequest.begin();detailPending=false;viewKey=null;lastResponse=null;lastChecked=null;$('detail-status').textContent='Data source unavailable';$('detail').replaceChildren(node('p','Device information is unavailable. Previous results have been cleared.','empty'));}
}
async function loadDetail({background=false}={}){
 const key=`${selected}/${$('epoch').value}`;
 if(!selected || (background&&(detailPending||viewKey!==key)))return;
 const request=detailRequest.begin();detailPending=true;
 if(!background){viewKey=key;lastResponse=null;lastChecked=null;$('detail').replaceChildren(node('p','Loading confirmed observations and the confidence report…','empty'));}
 $('detail-status').textContent=background?`Updating… ${lastChecked?`Showing the last check from ${lastChecked}.`:'Retrying the data source.'}`:'Checking this period…';
 try{
  const epoch=Number($('epoch').value);if($('epoch').value===''||!Number.isInteger(epoch)||epoch<0||epoch>4294967295)throw Error('Invalid period');
  const data=await get(`/api/devices/${selected}?epoch=${epoch}`,request.signal);if(!detailRequest.current(request))return;
  const snapshot=JSON.stringify(data);if(snapshot!==lastResponse){render(data);lastResponse=snapshot;}
  lastChecked=new Date().toLocaleTimeString('en-GB');$('detail-status').textContent=`Last checked ${lastChecked} · Next automatic check in about 15 seconds.`;
 }catch(error){if(!detailRequest.current(request)||error.name==='AbortError')return;lastResponse=null;lastChecked=null;$('detail-status').textContent='Update failed · No active score';$('detail').replaceChildren(node('p','We couldn’t load a consistent view of this period. Select View period to try again. The previous score has been cleared.','empty'));}
 finally{if(detailRequest.current(request))detailPending=false;}
}
function render(data){
 const root=$('detail');root.replaceChildren();const identity=node('section',undefined,'identity');identity.append(node('h3',`Device · ${data.device.id.slice(0,12)}…`),node('p',`Declared location: ${data.device.declaredLocation??'not provided'}. This is information supplied by the operator, not a verified GPS position.`),details('Device identity details',node('code',`Device ID: ${data.device.id}`),node('code',`Public key: ${data.device.key}`),node('p',`Capabilities bitmask: ${data.device.capabilities}`),link('address',data.device.address,'View registration on Solana ↗')));root.append(identity);
 root.append(declaredAreaMap(data.device.declaredLocation));
 const metrics=node('div',undefined,'metrics');metrics.append(item('Reporting period',data.epoch),item('Recorded observations',data.state?.observers??0),item('Reward allocations',data.state?.paidSlots??0));root.append(metrics,node('p','Observations do not necessarily represent different people. Reward allocations are not completed withdrawals.','note'));
 const chainDetails=[node('p',`Epoch: ${data.epoch} · Policy version: ${data.policyVersion}`)];
 if(data.state)chainDetails.push(node('code',`Observation root: ${data.state.root}`),node('code',`On-chain confidence commitment: ${data.state.commitment}`));
 root.append(details('Blockchain record details',...chainDetails));
 const confidence=data.confidence,section=node('section',undefined,'confidence');section.append(node('h3','Confidence report'));
 if(confidence.status!=='published'){
  const explanations={unavailable:'Report unavailable. The report service could not be reached or its response could not be verified.',missing:'No report is available for this period.',stale:'Report needs updating. The previous report is no longer active; a new observation or a change to the scoring rules may have invalidated it.'};
  section.append(node('p',`${explanations[confidence.status]??'Report unavailable.'} No confidence score is shown.`,'empty'),details('Report status details',node('code',`API status: ${confidence.status}`)));
 }
 else{
  section.append(node('strong',`${percentage(confidence.score)} · ${confidence.label==='LOW'?'Limited confidence':'Policy threshold met'}`,'score'),node('p',`This score summarizes the available evidence; it is not the probability that a location is correct. Evaluated ${new Date(confidence.evaluatedAt).toLocaleString('en-GB',{timeZone:'UTC'})} UTC. It describes that moment, not continuous monitoring.`,'note'));
  const labels={hardware_confidence:['Observer attestation','Hardware attestation of the observing phone (App Attest, StrongBox or TEE), adjusted for available enrollment-risk evidence. This is separate from the observed device’s signature.'],temporal_freshness:['Observation recency','How recent the evidence was when this report was evaluated.'],witness_diversity:['Observer diversity','Contribution from grouped observers, with conservative weighting.'],spatial_consistency:['Location consistency','How well the available location signals agree.'],behavior_diversity:['Behavior diversity','Variety of behavior represented in the evidence.'],service_evidence:['Service evidence','Evidence that the device provides its intended service.']};
  const facets=node('div',undefined,'facets');for(const [name,value]of Object.entries(confidence.facets)){const [label,explanation]=labels[name]??[name,''];const row=node('div',undefined,'facet');const caption=node('div');caption.append(node('span',label),node('p',explanation,'note'));const progress=node('progress');progress.max=10000;progress.value=value;progress.setAttribute('aria-label',label);row.append(caption,progress,node('strong',percentage(value)));facets.append(row);}section.append(facets,node('p','A low or zero criterion can reflect missing evidence, not necessarily a faulty device.'));
  section.append(node('p',`${confidence.observers.raw} recorded observations, combined into ${confidence.observers.groups} observer ${confidence.observers.groups===1?'group':'groups'}. Related observations are grouped to avoid overstating diversity.`),details('Scoring and evidence details',node('code',`Policy label: ${confidence.label} · Policy version: ${confidence.policyVersion}`),node('code',`Evaluated at: ${new Date(confidence.evaluatedAt).toISOString()}`),node('p','Each observer group contributes at most 0.2 without demonstrated cross-deployer history.'),node('p',`Reenrollment risk: ${confidence.coverage.reenrollmentRiskAvailable?'available':'unavailable'}. Cross-deployer history: unavailable.`),node('code',`Confidence commitment: ${confidence.commitment}`),...Object.entries(confidence.facets).map(([name,value])=>node('code',`${name}: ${value}/10000`))));if(confidence.signature)section.append(link('tx',confidence.signature,'View report publication on Solana ↗'));
 }root.append(section);
 const observations=node('section',undefined,'observations');observations.append(node('h3','Recorded observations'));
 if(!data.observations.length)observations.append(node('p','No observations have been confirmed on the blockchain for this period. Pending submissions and off-chain validation receipts are not included.'));
 for(const [index,record]of data.observations.entries()){const row=node('div',undefined,'observation');row.append(node('strong',`Observation ${index+1}`),node('span',`Confirmed on Solana · ${record.paid?'Reward allocated (not withdrawn)':'No reward allocation'}`),link('address',record.address,'View blockchain record ↗'),details(`Observation ${index+1} technical details`,node('code',`Transcript hash: ${record.hash}`),node('p',`Observer class: ${record.observerClass} · Finalized commitment account`)));observations.append(row);}root.append(observations);
}
$('reload').onclick=()=>{loadList();if(selected)loadDetail();};$('previous').onclick=()=>{offset=Math.max(0,offset-25);loadList();};$('next').onclick=()=>{offset+=25;loadList();};$('epoch-form').onsubmit=event=>{event.preventDefault();loadDetail();};
async function poll(){try{if(selected&&!document.hidden)await loadDetail({background:true});}finally{setTimeout(poll,15000);}}
loadList();setTimeout(poll,15000);
