import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { splitReward, claimDigest, claimPayout, paymentAddresses, decodePayout, discriminator, formatUSDC } from '../src/index.ts';

test('DEV-36 integer split conserves gross, floors fees, rejects overflow',()=>{
  for (const gross of [0n,1n,4n,5n,49999n,50000n,0xffff_ffff_ffff_ffffn]) {
    const r=splitReward(gross); assert.equal(r.net+r.fee,gross);
  }
  assert.deepEqual(splitReward(50000n),{gross:50000n,fee:10000n,net:40000n});
  assert.equal(formatUSDC(40000n),'0.040000');
  assert.throws(()=>splitReward(-1n)); assert.throws(()=>splitReward(1n,10001));
});
test('DEV-36 payout accounts isolate protocol/pseudonym; accounting cannot be forged',()=>{
  const program=Keypair.generate().publicKey,p=Buffer.alloc(32,1),s=Buffer.alloc(32,2);
  assert.notEqual(paymentAddresses(program,p,s).payout.toBase58(),paymentAddresses(program,Buffer.alloc(32,3),s).payout.toBase58());
  const data=Buffer.alloc(176); discriminator('account','Payout').copy(data); p.copy(data,8); s.copy(data,40);
  Keypair.generate().publicKey.toBuffer().copy(data,72);
  data.writeBigUInt64LE(50000n,136);data.writeBigUInt64LE(10000n,144);data.writeBigUInt64LE(40000n,152);
  assert.equal(decodePayout(data).available,40000n);
  data.writeBigUInt64LE(1n,160);assert.throws(()=>decodePayout(data),/accounting/);
});
test('DEV-36 claim authorization cannot be reused for another destination, amount or nonce',()=>{
  const keys=Array.from({length:5},()=>Keypair.generate().publicKey.toBase58());
  const value={program:keys[0]!,payout:keys[1]!,mint:keys[2]!,withdrawalKey:keys[3]!,destination:keys[4]!,amount:'40000',nonce:'0',expiresAt:'100',policyVersion:1};
  for(const changed of [{destination:PublicKey.default.toBase58()},{amount:'1'},{nonce:'1'},{expiresAt:'101'},{policyVersion:2}]) {
    assert.notDeepEqual(claimDigest(value),claimDigest({...value,...changed}));
  }
  const ix=claimPayout(new PublicKey(value.program),Buffer.alloc(32,1),Buffer.alloc(32,2),new PublicKey(value.mint),new PublicKey(value.withdrawalKey),new PublicKey(value.destination),40000n,0n,100n);
  assert.equal(ix.data.length,32);assert.equal(ix.keys[5]!.isSigner,true);
});
