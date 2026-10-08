import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { deviceId, BN254_MODULUS } from '@pathnod/solana';

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const OTHER_PUBLIC_CLUSTERS = ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'];
export function demoTarget(raw: string, localValidator?: boolean, genesis?: string) {
  const rpc=new URL(raw), local=['localhost','127.0.0.1','[::1]'].includes(rpc.hostname);
  if(rpc.username||rpc.password||rpc.search||rpc.hash)throw Error('Invalid demo RPC URL');
  if(local ? localValidator!==true || !genesis || !['http:','https:'].includes(rpc.protocol) : rpc.href!=='https://api.devnet.solana.com/') {
    throw Error('Only explicit local validator or official devnet is permitted');
  }
  const expected=local?genesis!:DEVNET_GENESIS;
  if(OTHER_PUBLIC_CLUSTERS.includes(expected)||local&&expected===DEVNET_GENESIS)throw Error('Local test target cannot select a public cluster genesis');
  return {rpc,local,expected};
}
export function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function within(root: string, file: string): boolean {
  const relative = path.relative(root,file);
  return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
/** Resolve symlinks too: a lexical /tmp path pointing into Git is not outside Git. */
export async function externalFile(file: string, repo: string): Promise<string> {
  if (!path.isAbsolute(file)) throw Error('Use absolute paths for demo inputs and state');
  const resolved = await realpath(file);
  if (within(await realpath(repo),resolved)) throw Error('Keep demo keys, state and prover artifacts outside Git');
  return resolved;
}
export async function privateFile(file: string, repo: string): Promise<string> {
  const resolved = await externalFile(file,repo), info = await stat(resolved);
  if (!info.isFile() || info.mode & 0o077) throw Error('Private input must be a regular file with permissions 600');
  return resolved;
}
export function hardwareInfo(bytes: Buffer) {
  if (bytes.length !== 70 || bytes[0] !== 0 || bytes[1] !== 1 || bytes.subarray(2,34).every(b=>b===0)) {
    throw Error('Supply the actual 70-byte ESP32 INFO (version 0, Ed25519)');
  }
  const key = bytes.subarray(2,34);
  return { key: key.toString('hex'), device: deviceId(key).toString('hex'), capabilities:bytes.readUInt32BE(34) };
}
export function canonicalRoot(root: string, leafCount: number) {
  if (!/^[a-f0-9]{64}$/.test(root) || BigInt('0x'+root) === 0n || BigInt('0x'+root) >= BN254_MODULUS ||
      !Number.isInteger(leafCount) || leafCount < 1 || leafCount > 2**20) throw Error('Invalid enrolled observer root');
  return { root,leafCount };
}
/** Returning 'unknown' must halt, never rebuild an ambiguous transaction. */
export function pendingDecision(status: { err: unknown; confirmationStatus?: string | null } | null,
  currentHeight: number, lastValidHeight: number): 'finalized' | 'failed' | 'retry' | 'expired' | 'unknown' {
  if (status?.err) return 'failed';
  if (status?.confirmationStatus === 'finalized') return 'finalized';
  if (status !== null) return 'unknown';
  return currentHeight <= lastValidHeight ? 'retry' : 'expired';
}
