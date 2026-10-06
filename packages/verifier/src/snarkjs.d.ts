declare module "snarkjs" {
  export const groth16: {
    verify(key: unknown, inputs: string[], proof: unknown): Promise<boolean>;
  };
}
