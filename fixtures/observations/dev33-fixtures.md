# DEV-33 public verification fixtures

`dev33-proof.json` is a real Mopro Groth16 proof for the first **synthetic**
DEV-31 `transcript-v0.json` vector (seven public inputs). The matching
`dev33-verification-key.json` was exported from the existing local DEV-13
development setup. Its SHA-256 is
`101396b89e38419be836f90d3ff9e9b2d4cd77113e3b3f125cb07f3cde859feb`.

These are public test artifacts, not real observations, a production ceremony,
or a production VK recommendation. No proving key, observer private credential
from a real device, or Apple assertion is committed. Tests generate a synthetic
P256 observer key and a genuine signature in memory; they do not bypass the
App Attest assertion verification code. Synthetic enrollment is injected only
inside the test database. Apple certificate attestation and physical iPhone
integration are distinct tests.

Regenerate the proof with the documented DEV-32 Mopro submission test and
export the matching verification key with the DEV-13 setup tooling. Always
regenerate this pair together; changing only the VK invalidates the proof.
