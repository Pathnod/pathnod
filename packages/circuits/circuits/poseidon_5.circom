pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";

template PoseidonCompatibility5() {
    signal input in[5];
    signal output out;

    component poseidon = Poseidon(5);
    for (var i = 0; i < 5; i++) {
        poseidon.inputs[i] <== in[i];
    }
    out <== poseidon.out;
}

component main = PoseidonCompatibility5();
