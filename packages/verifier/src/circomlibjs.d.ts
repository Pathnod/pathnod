declare module "circomlibjs" {
  export function buildPoseidon(): Promise<{
    (inputs: bigint[]): Uint8Array;
    F: { toObject(value: Uint8Array): bigint };
  }>;
}
