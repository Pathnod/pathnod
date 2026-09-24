declare module "circomlibjs" {
  interface PoseidonField {
    toObject(value: unknown): bigint;
  }

  interface Poseidon {
    (inputs: bigint[]): unknown;
    F: PoseidonField;
  }

  export function buildPoseidon(): Promise<Poseidon>;
}
