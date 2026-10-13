fn main() {
    // anchor-lang-idl 0.1.4 has a literal +{toolchain} argument bug.
    // Let the checked-in rust-toolchain.toml select the child compiler.
    std::env::remove_var("RUSTUP_TOOLCHAIN");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let idl = anchor_lang_idl::build::IdlBuilder::new()
        .program_path(root.join("programs/realize-escrow"))
        .build()
        .expect("IDL generation failed");
    let bytes = serde_json::to_vec_pretty(&idl).unwrap();
    std::fs::write(root.join("idl/realize_escrow.json"), &bytes).unwrap();
    std::fs::write(root.join("packages/realize-solana/src/idl.json"), &bytes).unwrap();
}
