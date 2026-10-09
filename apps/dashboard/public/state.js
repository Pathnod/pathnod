export class LatestRequest {
  generation = 0;
  controller;
  begin() { this.controller?.abort(); this.controller = new AbortController(); return { generation: ++this.generation, signal: this.controller.signal }; }
  current(request) { return request.generation === this.generation; }
}
export function percentage(value) { if (!Number.isInteger(value) || value < 0 || value > 10000) throw Error('Invalid score'); return `${(value / 100).toFixed(2)}%`; }
export function explorer(network, kind, address) {
  if(network !== 'devnet' || !['address','tx'].includes(kind) || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address))return null;
  return `https://explorer.solana.com/${kind}/${address}?cluster=devnet`;
}
