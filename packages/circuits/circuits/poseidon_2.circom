pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";

template PoseidonCompatibility2() {
    signal input in[2];
    signal output out;

    component poseidon = Poseidon(2);
    for (var i = 0; i < 2; i++) {
        poseidon.inputs[i] <== in[i];
    }
    out <== poseidon.out;
}

component main = PoseidonCompatibility2();
