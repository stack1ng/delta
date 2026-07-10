# Toolchain split (pyro decision 0004): Nix pins tools; Bun's lockfile pins
# JS packages. node_modules is never Nix-managed.
{ pkgs }:
let
  rustToolchain = pkgs.rust-bin.stable.latest.default.override {
    targets = [ "wasm32-unknown-unknown" ];
  };
  llvm = pkgs.llvmPackages_19;
  # clang-unwrapped ships its builtin headers (limits.h, stddef.h, ...) in the
  # .lib output; libzstd's wasm build needs them alongside zstd-sys' wasm-shim.
  clangResourceInclude = "${llvm.clang-unwrapped.lib}/lib/clang/${pkgs.lib.versions.major llvm.clang-unwrapped.version}/include";
in
pkgs.mkShell {
  packages = [
    pkgs.bun
    pkgs.nodejs_24
    pkgs.biome
    rustToolchain
    llvm.clang-unwrapped
    llvm.bintools-unwrapped
    pkgs.binaryen
    pkgs.pkg-config
    pkgs.zstd # CLI for known-content-size interop fixtures in tests
  ];

  # Explicit store paths: on darwin the stdenv's wrapped clang shadows bare
  # `clang` on PATH and injects host flags that break wasm32 cross-compiles.
  env = {
    CC_wasm32_unknown_unknown = "${llvm.clang-unwrapped}/bin/clang";
    AR_wasm32_unknown_unknown = "${llvm.bintools-unwrapped}/bin/llvm-ar";
    CFLAGS_wasm32_unknown_unknown = "-isystem ${clangResourceInclude}";
  };

  shellHook = ''
    if [ -t 1 ]; then
      echo "delta devshell: bun $(bun --version), node $(node --version), $(rustc --version | cut -d' ' -f1-2)"
    fi
  '';
}
