pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";

// DEV-12: membership and scope-only derivations. BLE measurements and device
// signatures are deliberately verified outside this circuit.
template Observation(depth) {
    signal input s_obs;
    signal input class;
    signal input merkle_path[depth];
    signal input merkle_index[depth];

    signal input root;
    signal input protocol_id_f;
    signal input device_id_f;
    signal input epoch;
    signal input nullifier;
    signal input pseudonym;
    signal input class_pub;

    // Hardware classes are 1 = iOS App Attest, 2 = Android StrongBox,
    // 3 = Android TEE. The private class is also exposed as class_pub.
    signal class_range_step;
    class_range_step <== (class - 1) * (class - 2);
    class_range_step * (class - 3) === 0;
    class_pub === class;

    component commitment = Poseidon(1);
    commitment.inputs[0] <== s_obs;

    component leaf = Poseidon(2);
    leaf.inputs[0] <== commitment.out;
    leaf.inputs[1] <== class;

    signal nodes[depth + 1];
    nodes[0] <== leaf.out;
    component hashes[depth];
    for (var i = 0; i < depth; i++) {
        merkle_index[i] * (merkle_index[i] - 1) === 0;
        hashes[i] = Poseidon(2);
        hashes[i].inputs[0] <== nodes[i] + merkle_index[i] * (merkle_path[i] - nodes[i]);
        hashes[i].inputs[1] <== merkle_path[i] + merkle_index[i] * (nodes[i] - merkle_path[i]);
        nodes[i + 1] <== hashes[i].out;
    }
    root === nodes[depth];

    component nullifier_hash = Poseidon(5);
    nullifier_hash.inputs[0] <== 1; // DOMAIN_NULL
    nullifier_hash.inputs[1] <== s_obs;
    nullifier_hash.inputs[2] <== protocol_id_f;
    nullifier_hash.inputs[3] <== device_id_f;
    nullifier_hash.inputs[4] <== epoch;
    nullifier === nullifier_hash.out;

    component pseudonym_hash = Poseidon(3);
    pseudonym_hash.inputs[0] <== 2; // DOMAIN_PSEUD
    pseudonym_hash.inputs[1] <== s_obs;
    pseudonym_hash.inputs[2] <== protocol_id_f;
    pseudonym === pseudonym_hash.out;
}

component main {public [root, protocol_id_f, device_id_f, epoch, nullifier, pseudonym, class_pub]} = Observation(20);
