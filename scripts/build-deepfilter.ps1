param([string]$RustToolchain = '1.99.0')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $taskRoot 'audio\vendor\deepfilter\rust\Cargo.toml'
$env:CARGO_TARGET_DIR = Join-Path $taskRoot '.local\dfn-target'
$env:RUSTFLAGS = '-C target-feature=+simd128 --cfg getrandom_backend="custom"'
& cargo "+$RustToolchain" build --manifest-path $manifestPath --target wasm32-unknown-unknown --release --locked
if ($LASTEXITCODE -ne 0) { throw 'DeepFilterNet compilation failed.' }
$binaryPath = Join-Path $env:CARGO_TARGET_DIR 'wasm32-unknown-unknown\release\freqx_dfn3.wasm'
$pin = Get-Content -LiteralPath (Join-Path $taskRoot 'audio\vendor\deepfilter\manifest.json') -Raw | ConvertFrom-Json
$hash = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $pin.files.'df_bg.wasm'.sha256) { throw "Rebuilt binary differs from the reviewed pin ($hash). Review source/toolchain/ABI before updating manifest.json." }
Copy-Item -LiteralPath $binaryPath -Destination (Join-Path $taskRoot 'audio\vendor\deepfilter\df_bg.wasm')
Write-Output 'Rebuilt and verified the pinned local DeepFilterNet3 SIMD model.'
