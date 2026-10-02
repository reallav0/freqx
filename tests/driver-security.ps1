$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../installer/driver-verification.ps1')
$directory = Join-Path ([IO.Path]::GetTempPath()) ('freqx-driver-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $directory | Out-Null
$script:launches = 0
try {
  $setup = Join-Path $directory 'setup.exe'
  $inf = Join-Path $directory 'driver.inf'
  Set-Content -LiteralPath $setup -Value 'test executable'
  Set-Content -LiteralPath $inf -Value 'CatalogFile = driver.cat'
  Set-Content -LiteralPath (Join-Path $directory 'driver.cat') -Value 'test catalog'
  $thumbprint = 'A' * 40
  $policy = @{ version = 1; allowedSignerThumbprints = @($thumbprint); files = @(Get-ChildItem $directory | ForEach-Object {
    @{ path = $_.Name; size = $_.Length; sha256 = (Get-FileHash $_.FullName).Hash }
  }) }
  # Keep the policy outside the verified package.
  $policyPath = "$directory.json"
  $policy | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $policyPath
  $launch = { param($target) $script:launches++; return 0 }
  $valid = { param($target) @{ Status = 'Valid'; Thumbprint = 'A' * 40 } }
  $result = Invoke-VerifiedDriverSetup $setup $inf $policyPath $valid $launch
  if ($result -ne 0 -or $script:launches -ne 1) { throw 'Valid reviewed package did not launch exactly once.' }
  $script:launches = 0
  $failures = @(
    { param($target) throw 'verification threw' },
    { param($target) throw [TimeoutException]::new('verification timed out') },
    { param($target) return $null },
    { param($target) @{ Status = 'Unknown'; Thumbprint = 'A' * 40 } },
    { param($target) @{ Status = 'NotTrusted'; Thumbprint = 'A' * 40 } },
    { param($target) @{ Status = 'Valid'; Thumbprint = 'B' * 40 } },
    { param($target) @{ Status = 'Valid' } },
    { param($target) 'malformed output' }
  )
  foreach ($reader in $failures) {
    $blocked = $false
    try { Invoke-VerifiedDriverSetup $setup $inf $policyPath $reader $launch | Out-Null } catch { $blocked = $true }
    if (-not $blocked -or $script:launches -ne 0) { throw 'Verification failure allowed execution.' }
  }
  Set-Content -LiteralPath $setup -Value 'tampered'
  $blocked = $false
  try { Invoke-VerifiedDriverSetup $setup $inf $policyPath $valid $launch | Out-Null } catch { $blocked = $true }
  if (-not $blocked -or $script:launches -ne 0) { throw 'Hash mismatch allowed execution.' }
  $blocked = $false
  try { Invoke-VerifiedDriverSetup $setup $inf (Join-Path $PSScriptRoot '../installer/driver-policy.json') $valid $launch | Out-Null } catch { $blocked = $true }
  if (-not $blocked -or $script:launches -ne 0) { throw 'Empty production policy allowed execution.' }
  Write-Output 'PASS driver verification success and ten fail-closed cases'
} finally {
  $absolute = [IO.Path]::GetFullPath($directory)
  if ((Split-Path -Parent $absolute) -ne ([IO.Path]::GetTempPath()).TrimEnd('\') -or (Split-Path -Leaf $absolute) -notlike 'freqx-driver-test-*') { throw 'Unsafe test cleanup.' }
  Remove-Item -LiteralPath $absolute -Recurse -Force
  if (Test-Path -LiteralPath "$directory.json") { Remove-Item -LiteralPath "$directory.json" -Force }
}
