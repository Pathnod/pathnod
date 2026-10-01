fn main() {
    std::env::set_var("IPHONEOS_DEPLOYMENT_TARGET", "18.0");
    rust_witness::transpile::transpile_wasm("./LocalCircuits".to_string());
}
