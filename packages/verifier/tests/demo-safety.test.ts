import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deviceId, BN254_MODULUS } from '@pathnod/solana';
import { canonicalRoot, hardwareInfo, pendingDecision, externalFile, privateFile, within, demoTarget, DEVNET_GENESIS } from '../src/demo-safety.ts';

test('DEV-37 rejects mainnet/testnet and unexpected RPCs, including localhost proxies',()=>{
  assert.equal(demoTarget('https://api.devnet.solana.com').expected,DEVNET_GENESIS);
  assert.equal(demoTarget('http://127.0.0.1:18999',true,'local-test-genesis').local,true);
  for(const url of ['https://api.mainnet-beta.solana.com','https://api.testnet.solana.com','https://example.com','https://api.devnet.solana.com/?key=secret'])assert.throws(()=>demoTarget(url));
  for(const genesis of [DEVNET_GENESIS,'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'])assert.throws(()=>demoTarget('http://localhost:8899',true,genesis));
  assert.throws(()=>demoTarget('http://127.0.0.1:8899'));
});

test('DEV-37 hardware INFO derives the actual ID and rejects incomplete or fake-shaped inputs',()=>{
  const info=Buffer.alloc(70);info[1]=1;info.fill(7,2,34);info.writeUInt32BE(10,34);
  const d=hardwareInfo(info);assert.equal(d.device,deviceId(info.subarray(2,34)).toString('hex'));assert.equal(d.capabilities,10);
  for(const bad of [info.subarray(0,38),Buffer.alloc(70),Buffer.concat([info,Buffer.from([0])])])assert.throws(()=>hardwareInfo(bad));
  info[0]=1;assert.throws(()=>hardwareInfo(info));info[0]=0;info[1]=2;assert.throws(()=>hardwareInfo(info));
});
test('DEV-37 roots must be canonical nonzero depth-20 tree roots',()=>{
  assert.deepEqual(canonicalRoot('1'.padStart(64,'0'),1),{root:'1'.padStart(64,'0'),leafCount:1});
  for(const root of ['0'.repeat(64),BN254_MODULUS.toString(16).padStart(64,'0'),'xyz'])assert.throws(()=>canonicalRoot(root,1));
  for(const count of [0,-1,2**20+1,1.2])assert.throws(()=>canonicalRoot('1'.padStart(64,'0'),count));
});
test('DEV-37 ambiguous transactions preserve exact bytes until a finalized decision',()=>{
  assert.equal(pendingDecision(null,99,100),'retry');assert.equal(pendingDecision(null,101,100),'expired');
  assert.equal(pendingDecision({err:null,confirmationStatus:'confirmed'},101,100),'unknown');
  assert.equal(pendingDecision({err:null,confirmationStatus:'finalized'},101,100),'finalized');
  assert.equal(pendingDecision({err:{InstructionError:[0,1]},confirmationStatus:'finalized'},99,100),'failed');
});
test('DEV-37 rejects private artifacts inside Git and symlink escapes',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'pathnod-demo-safety-'));
  try {
    const repo=path.join(folder,'repo');await mkdir(repo);
    const inside=path.join(repo,'secret.json'),outside=path.join(folder,'wallet.json');
    await writeFile(inside,'[]',{mode:0o600});await writeFile(outside,'[]',{mode:0o600});
    const link=path.join(folder,'link.json');await symlink(inside,link);
    await assert.rejects(()=>externalFile(link,repo),/outside Git/);
    await assert.rejects(()=>externalFile(inside,repo),/outside Git/);
    assert.equal(await privateFile(outside,repo),await realpath(outside));
    const publicFile=path.join(folder,'public.json');await writeFile(publicFile,'[]',{mode:0o644});
    await assert.rejects(()=>privateFile(publicFile,repo),/600/);
    assert.equal(within(repo,repo+'-other/file'),false);
  } finally {await rm(folder,{recursive:true,force:true});}
});
