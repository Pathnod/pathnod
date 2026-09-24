pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";

template PoseidonCompatibility1() {
    signal input in[1];
    signal output out;

    component poseidon = Poseidon(1);
    poseidon.inputs[0] <== in[0];
    out <== poseidon.out;
}

component main = PoseidonCompatibility1();
