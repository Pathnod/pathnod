import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../../..',import.meta.url);
const sha=(...parts)=>createHash('sha256').update(Buffer.concat(parts.map(v=>typeof v==='string'?Buffer.from(v):v))).digest();
const transcripts=Array.from({length:5},(_,i)=>Buffer.alloc(32,0x10+i));
const empty=sha('Pathnod/observation-empty/v0');
const roots=[];
for(let count=1;count<=5;count++) {
 let nodes=Array.from({length:65536},(_,i)=>i<count?sha('Pathnod/observation-leaf/v0',transcripts[i]):empty);
 while(nodes.length>1){const parent=[];for(let i=0;i<nodes.length;i+=2)parent.push(sha('Pathnod/observation-node/v0',nodes[i],nodes[i+1]));nodes=parent;}
 roots.push(nodes[0].toString('hex'));
}
await writeFile(new URL('fixtures/observations/dev35-tree.json',root),JSON.stringify({publicTestVectors:true,depth:16,transcriptHashes:transcripts.map(v=>v.toString('hex')),roots},null,2)+'\n');
const proofs=JSON.parse(await readFile(new URL('fixtures/observations/dev35-proofs.json',root),'utf8'));
const fq=21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const bytes=v=>Buffer.from(BigInt(v).toString(16).padStart(64,'0'),'hex');
for(const vector of proofs.vectors) {
 const p=vector.proof;
 vector.proofBytes=Buffer.concat([bytes(p.pi_a[0]),bytes((fq-BigInt(p.pi_a[1]))%fq),...[p.pi_b[0][1],p.pi_b[0][0],p.pi_b[1][1],p.pi_b[1][0]].map(bytes),bytes(p.pi_c[0]),bytes(p.pi_c[1]),...vector.public.map(bytes)]).toString('hex');
}
await writeFile(new URL('fixtures/observations/dev35-proofs.json',root),JSON.stringify(proofs,null,2)+'\n');
console.log('Generated independent full-tree roots and shared proof byte vectors.');
