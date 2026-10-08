import { PublicKey } from '@solana/web3.js';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export interface DashboardConfig {
  rpc: URL; verifier: URL; program: PublicKey; protocol: Buffer; genesis: string;
  network: 'devnet' | 'local-validator'; host: string; port: number;
}
export function endpoint(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      !['https:', 'http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw Error('Use HTTPS or loopback HTTP without credentials, query or fragment');
  }
  return url;
}
export function configFromEnv(env: NodeJS.ProcessEnv): DashboardConfig {
  const required = (name: string) => { const v = env[name]; if (!v) throw Error(`Missing ${name}`); return v; };
  const network = required('PATHNOD_DASHBOARD_NETWORK');
  if (network !== 'devnet' && network !== 'local-validator') throw Error('Unsupported dashboard network');
  const rpc = endpoint(required('PATHNOD_DASHBOARD_RPC_URL'));
  const genesis = required('PATHNOD_DASHBOARD_GENESIS');
  if (network === 'devnet' && (genesis !== DEVNET_GENESIS || rpc.href !== 'https://api.devnet.solana.com/')) throw Error('Devnet requires official RPC and genesis');
  if (network === 'local-validator' && (!['localhost','127.0.0.1','[::1]'].includes(rpc.hostname) || genesis === DEVNET_GENESIS)) throw Error('Local validator requires loopback and its actual genesis');
  const protocol = required('PATHNOD_DASHBOARD_PROTOCOL_ID');
  if (!/^[a-f0-9]{64}$/.test(protocol) || protocol === '0'.repeat(64)) throw Error('Invalid protocol');
  const program = new PublicKey(required('PATHNOD_DASHBOARD_PROGRAM_ID'));
  if (program.equals(PublicKey.default)) throw Error('Invalid program');
  const port = Number(env.PORT ?? '4173');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid port');
  return { rpc, verifier: endpoint(required('PATHNOD_DASHBOARD_VERIFIER_URL')), program,
    protocol: Buffer.from(protocol,'hex'), genesis, network, host: env.HOST ?? '127.0.0.1', port };
}
