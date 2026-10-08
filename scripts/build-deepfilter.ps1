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
if ($hash -ne $pin.files.'df_bg.wasm'.sha256) {
  $candidateDirectory = Join-Path $taskRoot 'output\dfn3-rebuild'
  New-Item -ItemType Directory -Force -Path $candidateDirectory | Out-Null
  Copy-Item -LiteralPath $binaryPath -Destination (Join-Path $candidateDirectory 'df_bg.wasm')
  Write-Output "Built candidate: $candidateDirectory\df_bg.wasm (SHA256 $hash)."
  Write-Output 'Binary hashes may vary with compiler paths and build-time crate seeds. The existing runtime pin remains intact; review the candidate ABI/output before updating the asset and manifest.'
  exit 0
}
Copy-Item -LiteralPath $binaryPath -Destination (Join-Path $taskRoot 'audio\vendor\deepfilter\df_bg.wasm')
Write-Output 'Rebuilt and verified the pinned local DeepFilterNet3 SIMD model.'
