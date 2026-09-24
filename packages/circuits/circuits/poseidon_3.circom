pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";

template PoseidonCompatibility3() {
    signal input in[3];
    signal output out;

    component poseidon = Poseidon(3);
    for (var i = 0; i < 3; i++) {
        poseidon.inputs[i] <== in[i];
    }
    out <== poseidon.out;
}

component main = PoseidonCompatibility3();
