import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { bytes32, discriminator, registryAddresses, TOKEN_PROGRAM, BN254_MODULUS } from './index.ts';

export function paymentAddresses(program: PublicKey, protocol: Uint8Array, pseudonym: Uint8Array) {
  const p = bytes32(protocol), s = bytes32(pseudonym);
  const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
  return { settings: pda(Buffer.from('payments')), feeVault: pda(Buffer.from('fees')),
    payout: pda(Buffer.from('payout'), p, s), vault: pda(Buffer.from('payout-vault'), p, s) };
}
function u64(n: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }
function u32(n: number) { if (!Number.isInteger(n)) throw Error('Invalid u32'); const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function meta(pubkey: PublicKey, isWritable = false, isSigner = false) { return { pubkey, isWritable, isSigner }; }
function ix(programId: PublicKey, name: string, data: Buffer, keys: TransactionInstruction['keys']) {
  return new TransactionInstruction({ programId, keys, data: Buffer.concat([discriminator('global', name), data]) });
}
export function initializePayments(program: PublicKey, authority: PublicKey, mint: PublicKey, treasury: PublicKey) {
  const a = paymentAddresses(program, Buffer.alloc(32), Buffer.alloc(32));
  return ix(program, 'initialize_payments', Buffer.alloc(0), [meta(a.settings,true),
    meta(registryAddresses(program, Buffer.alloc(32)).enrollment), meta(mint), meta(treasury),
    meta(a.feeVault,true), meta(authority,true,true), meta(TOKEN_PROGRAM), meta(SystemProgram.programId)]);
}
export function updateFees(program: PublicKey, authority: PublicKey, feeBps: number) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw Error('Invalid fees');
  const data = Buffer.alloc(2); data.writeUInt16LE(feeBps);
  return ix(program, 'update_fees', data, [meta(paymentAddresses(program,Buffer.alloc(32),Buffer.alloc(32)).settings,true), meta(authority,false,true)]);
}
export function updatePolicy(program: PublicKey, protocol: Uint8Array, authority: PublicKey,
  policyVersion: number, verifier: PublicKey, grossReward: bigint, slots: number) {
  if (!Number.isInteger(slots) || slots < 0 || slots > 255 || policyVersion < 1 ||
      verifier.equals(PublicKey.default) || slots > 0 && grossReward === 0n) throw Error('Invalid policy');
  return ix(program, 'update_policy', Buffer.concat([u32(policyVersion),verifier.toBuffer(),u64(grossReward),Buffer.from([slots])]),
    [meta(registryAddresses(program,protocol).config,true),meta(authority,false,true)]);
}
export interface ClaimAuthorization {
  program: string; payout: string; mint: string; withdrawalKey: string; destination: string;
  amount: string; nonce: string; expiresAt: string; policyVersion: number;
}
export function claimDigest(value: ClaimAuthorization): Buffer {
  for (const n of [value.amount,value.nonce,value.expiresAt]) if (!/^(0|[1-9][0-9]{0,19})$/.test(n)) throw Error('Invalid claim integer');
  if (BigInt(value.amount) === 0n || BigInt(value.expiresAt) > 0x7fff_ffff_ffff_ffffn || value.policyVersion < 1) throw Error('Invalid claim');
  return createHash('sha256').update(Buffer.concat([Buffer.from('Pathnod/claim/v0'),
    ...[value.program,value.payout,value.mint,value.withdrawalKey,value.destination].map(v => new PublicKey(v).toBuffer()),
    u64(BigInt(value.amount)), u64(BigInt(value.nonce)), u64(BigInt(value.expiresAt)),u32(value.policyVersion)])).digest();
}
export function claimPayout(program: PublicKey, protocol: Uint8Array, pseudonym: Uint8Array,
  mint: PublicKey, withdrawalKey: PublicKey, destination: PublicKey, amount: bigint, nonce: bigint, expiresAt: bigint) {
  const a = paymentAddresses(program,protocol,pseudonym);
  if (amount <= 0n || expiresAt < 0n || expiresAt > 0x7fff_ffff_ffff_ffffn) throw Error('Invalid claim');
  return ix(program, 'claim_payout', Buffer.concat([u64(amount),u64(nonce),u64(expiresAt)]),
    [meta(registryAddresses(program,protocol).config),meta(a.payout,true),meta(mint),meta(a.vault,true),
      meta(destination,true),meta(withdrawalKey,false,true),meta(SYSVAR_INSTRUCTIONS_PUBKEY),meta(TOKEN_PROGRAM)]);
}
export function splitReward(gross: bigint, feeBps = 2_000) {
  if (gross < 0n || gross > 0xffff_ffff_ffff_ffffn || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw Error('Invalid reward');
  const fee = gross * BigInt(feeBps) / 10_000n;
  return { gross, fee, net: gross-fee };
}
export function formatUSDC(amount: bigint): string {
  if (amount < 0n) throw Error('Invalid USDC');
  return `${amount/1_000_000n}.${(amount%1_000_000n).toString().padStart(6,'0')}`;
}
export function decodePayout(data: Uint8Array) {
  const b = Buffer.from(data);
  if (b.length !== 176 || !b.subarray(0,8).equals(discriminator('account','Payout'))) throw Error('Invalid payout');
  const result = { protocol: b.subarray(8,40), pseudonym: b.subarray(40,72), mint: new PublicKey(b.subarray(72,104)),
    withdrawalKey: new PublicKey(b.subarray(104,136)), gross: b.readBigUInt64LE(136), fees: b.readBigUInt64LE(144),
    available: b.readBigUInt64LE(152), withdrawn: b.readBigUInt64LE(160), nonce: b.readBigUInt64LE(168) };
  if (result.gross !== result.fees+result.available+result.withdrawn ||
      BigInt('0x'+result.pseudonym.toString('hex')) >= BN254_MODULUS) throw Error('Invalid payout accounting');
  return result;
}
export function decodePaymentSettings(data: Uint8Array) {
  const b = Buffer.from(data);
  if (b.length !== 106 || !b.subarray(0,8).equals(discriminator('account','PaymentSettings'))) throw Error('Invalid payment settings');
  const result = { authority: new PublicKey(b.subarray(8,40)), mint: new PublicKey(b.subarray(40,72)),
    treasury: new PublicKey(b.subarray(72,104)), feeBps: b.readUInt16LE(104) };
  if (result.feeBps > 10_000 || [result.authority,result.mint,result.treasury].some(k=>k.equals(PublicKey.default))) throw Error('Invalid payment settings');
  return result;
}
