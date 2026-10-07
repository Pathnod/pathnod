import {readFile,writeFile} from 'node:fs/promises';
import {buildPoseidon} from 'circomlibjs';
const output=process.argv[2];
if(!output)throw Error('Supply an output file outside the repository');
const fixtures=JSON.parse(await readFile(new URL('../../../fixtures/observations/transcript-v0.json',import.meta.url),'utf8'));
const first=fixtures.vectors[0],second=fixtures.vectors[1];
const p=await buildPoseidon(),hash=inputs=>p.F.toObject(p(inputs));
const dec=hex=>BigInt(hex).toString();
const commitment0=hash([BigInt(first.secret)]),commitment1=hash([BigInt(second.secret)]);
const leaf0=hash([commitment0,1n]),leaf1=hash([commitment1,1n]);
const siblings1=[leaf0,...second.enrollment.siblings.slice(1).map(BigInt)],directions1=[1,...Array(19).fill(0)];
let root1=leaf1;
for(let i=0;i<20;i++)root1=directions1[i]?hash([siblings1[i],root1]):hash([root1,siblings1[i]]);
const protocol=BigInt(first.protocolField),device=BigInt(first.deviceField),epoch=42n;
const make=(secret,root,siblings,directions)=>{
 const nullifier=hash([1n,BigInt(secret),protocol,device,epoch]),pseudonym=hash([2n,BigInt(secret),protocol]);
 const publics=[root,protocol,device,epoch,nullifier,pseudonym,1n].map(String);
 return {secret,commitment:hash([BigInt(secret)]).toString(),public:publics,inputs:{s_obs:[dec(secret)],class:['1'],merkle_path:siblings.map(String),merkle_index:directions.map(String),
  root:[publics[0]],protocol_id_f:[publics[1]],device_id_f:[publics[2]],epoch:[publics[3]],nullifier:[publics[4]],pseudonym:[publics[5]],class_pub:['1']}};
};
await writeFile(output,JSON.stringify({publicTestVectors:true,vectors:[
 make(first.secret,BigInt(first.enrollment.root),first.enrollment.siblings.map(BigInt),first.enrollment.directions),
 make(second.secret,root1,siblings1,directions1)]},null,2)+'\n');
console.log('Prepared two public synthetic observer witnesses.');
