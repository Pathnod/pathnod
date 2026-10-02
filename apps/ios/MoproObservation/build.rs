use std::{env, fs, path::Path, process::Command};

const W2C2_REVISION: &str = "9de3c2be5a4ed8ef5fdbd536e445120594fb8530";

fn run(command: &mut Command) {
    let status = command
        .status()
        .expect("failed to run w2c2 bootstrap command");
    assert!(
        status.success(),
        "w2c2 bootstrap command failed: {command:?}"
    );
}

fn main() {
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR is set by Cargo");
    let source = Path::new(&out_dir).join("w2c2");
    let binary = source.join("build/w2c2/w2c2");

    if source.exists() {
        let revision = Command::new("git")
            .arg("-C")
            .arg(&source)
            .args(["rev-parse", "HEAD"])
            .output()
            .expect("failed to inspect w2c2 revision");
        if !revision.status.success()
            || String::from_utf8_lossy(&revision.stdout).trim() != W2C2_REVISION
        {
            fs::remove_dir_all(&source).expect("failed to replace unpinned w2c2 checkout");
        }
    }

    if !source.exists() {
        run(Command::new("git")
            .args(["clone", "--recursive", "https://github.com/vivianjeng/w2c2"])
            .arg(&source));
        run(Command::new("git").arg("-C").arg(&source).args([
            "checkout",
            "--detach",
            W2C2_REVISION,
        ]));
        run(Command::new("git").arg("-C").arg(&source).args([
            "submodule",
            "update",
            "--init",
            "--recursive",
        ]));
    }

    if !binary.is_file() {
        run(Command::new("cmake")
            .arg("-S")
            .arg(&source)
            .arg("-B")
            .arg(source.join("build")));
        run(Command::new("cmake")
            .arg("--build")
            .arg(source.join("build"))
            .args(["--target", "w2c2"]));
        assert!(binary.is_file(), "w2c2 binary was not built");
    }

    let path = env::join_paths(
        std::iter::once(
            binary
                .parent()
                .expect("w2c2 binary has a parent")
                .to_path_buf(),
        )
        .chain(env::split_paths(&env::var_os("PATH").unwrap_or_default())),
    )
    .expect("failed to set PATH for pinned w2c2");
    env::set_var("PATH", path);
    env::set_var("IPHONEOS_DEPLOYMENT_TARGET", "18.0");
    rust_witness::transpile::transpile_wasm("./LocalCircuits".to_string());
}
