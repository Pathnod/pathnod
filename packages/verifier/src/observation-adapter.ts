import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeObservationCommitment,
  decodeObservationVerifier,
  observationAddresses,
  submitObservation,
  DEVNET_USDC,
} from "@pathnod/solana";
import { hex32 } from "./observation-authorization.ts";
import type { ObservationRelayPayload } from "./observation-relay.ts";
import type { ObservationSubmissionAdapter } from "./solana-observation-relay.ts";

export class PathnodObservationSubmissionAdapter
  implements ObservationSubmissionAdapter
{
  readonly contract: string;
  readonly computeUnitLimit = 299_999;
  readonly verificationKeyHash: string;
  readonly mint: PublicKey;
  constructor(verificationKeyHash: string, mint = DEVNET_USDC) {
    hex32(verificationKeyHash);
    this.verificationKeyHash = verificationKeyHash;
    this.mint = mint;
    this.contract = `Pathnod/submit_observation/v2/${verificationKeyHash}/${mint.toBase58()}`;
  }
  async validateTarget(connection: Connection, program: PublicKey) {
    const address = PublicKey.findProgramAddressSync(
      [Buffer.from("observation-verifier")],
      program,
    )[0];
    const account = await connection.getAccountInfo(address, "finalized");
    if (
      !account ||
      account.executable ||
      !account.owner.equals(program) ||
      decodeObservationVerifier(account.data).keyDigest !==
        this.verificationKeyHash
    )
      throw Error("Observation circuit key/ABI mismatch");
  }
  instruction(
    program: PublicKey,
    payer: PublicKey,
    payload: ObservationRelayPayload,
  ) {
    return submitObservation(
      program,
      payer,
      hex32(payload.protocolID),
      hex32(payload.deviceID),
      hex32(payload.transcriptHash),
      hex32(payload.evidenceHash),
      Buffer.from(payload.proofBytes, "hex"),
      this.mint,
    );
  }
  async confirm(
    connection: Connection,
    program: PublicKey,
    payload: ObservationRelayPayload,
  ): Promise<boolean> {
    const address = observationAddresses(
      program,
      hex32(payload.protocolID),
      hex32(payload.deviceID),
      payload.epoch,
      hex32(payload.nullifier),
    ).commitment;
    const account = await connection.getAccountInfo(address, "finalized");
    if (!account) return false;
    if (account.executable || !account.owner.equals(program))
      throw Error("Untrusted observation commitment");
    const observed = decodeObservationCommitment(account.data);
    if (
      observed.protocolID.toString("hex") !== payload.protocolID ||
      observed.deviceID.toString("hex") !== payload.deviceID ||
      observed.epoch !== payload.epoch ||
      observed.nullifier.toString("hex") !== payload.nullifier ||
      observed.pseudonym.toString("hex") !== payload.pseudonym ||
      observed.observerClass !== payload.observerClass ||
      observed.transcriptHash.toString("hex") !== payload.transcriptHash ||
      observed.evidenceHash.toString("hex") !== payload.evidenceHash
    )
      throw Error("Mismatched observation commitment");
    return true;
  }
}
