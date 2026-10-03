Set-StrictMode -Version Latest
# Use this engine's built-in hashing functions even when PSModulePath was inherited from another PowerShell version.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop

function Get-BoundedDriverSignature {
  param([string]$FilePath, [int]$TimeoutSeconds = 15)
  $job = Start-Job -ArgumentList $FilePath -ScriptBlock {
    param($target)
    $ErrorActionPreference = 'Stop'
    $signature = Get-AuthenticodeSignature -LiteralPath $target
    if (-not $signature.SignerCertificate) { throw 'Missing signer certificate.' }
    @{ Status = [string]$signature.Status; Thumbprint = $signature.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress
  }
  try {
    $finished = Wait-Job -Job $job -Timeout $TimeoutSeconds
    if (-not $finished -or $job.State -ne 'Completed') { throw 'Driver signature verification failed or timed out.' }
    $output = @(Receive-Job -Job $job -ErrorAction Stop)
    if ($output.Count -ne 1 -or $output[0] -isnot [string]) { throw 'Malformed signature result.' }
    return ($output[0] | ConvertFrom-Json -ErrorAction Stop)
  } finally {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}

function Assert-VerifiedDriverPackage {
  param([string]$SetupPath, [string]$InfPath, [string]$PolicyPath,
    [scriptblock]$SignatureReader = { param($target) Get-BoundedDriverSignature $target })
  $policy = Get-Content -LiteralPath $PolicyPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  if ($policy.version -ne 1 -or @($policy.allowedSignerThumbprints).Count -eq 0 -or @($policy.files).Count -lt 3) {
    throw 'No reviewed driver policy is configured.'
  }
  $allowed = @($policy.allowedSignerThumbprints | ForEach-Object {
    if ($_ -isnot [string] -or $_ -notmatch '^[A-Fa-f0-9]{40,64}$') { throw 'Malformed signer policy.' }
    $_.ToUpperInvariant()
  })
  $root = Split-Path -Parent ([IO.Path]::GetFullPath($SetupPath))
  if ((Split-Path -Parent ([IO.Path]::GetFullPath($InfPath))) -ne $root) { throw 'INF must accompany setup.' }
  $catalogs = @(Get-Content -LiteralPath $InfPath -ErrorAction Stop | ForEach-Object {
    if ($_ -match '^\s*CatalogFile(?:\.[A-Za-z0-9_]+)?\s*=\s*([^;]+)') { $Matches[1].Trim().Trim('"') }
  } | Select-Object -Unique)
  if ($catalogs.Count -ne 1 -or $catalogs[0] -notmatch '^[A-Za-z0-9_-]+\.cat$') { throw 'Missing or ambiguous catalog.' }
  $reviewed = @{}
  foreach ($file in $policy.files) {
    if ($file.path -notmatch '^[A-Za-z0-9_.-]+$' -or $file.path.Contains('..') -or
      $file.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or $file.size -le 0 -or $reviewed.ContainsKey($file.path)) {
      throw 'Malformed file policy.'
    }
    $target = Join-Path $root $file.path
    $item = Get-Item -LiteralPath $target -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $file.size) {
      throw 'Invalid driver package file.'
    }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256 -ErrorAction Stop).Hash -ne $file.sha256) {
      throw 'Driver package hash mismatch.'
    }
    $reviewed[$file.path] = $true
  }
  foreach ($required in @((Split-Path -Leaf $SetupPath), (Split-Path -Leaf $InfPath), $catalogs[0])) {
    if (-not $reviewed.ContainsKey($required)) { throw 'Required driver file has not been reviewed.' }
  }
  foreach ($entry in Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop) {
    if ($entry.PSIsContainer -or -not $reviewed.ContainsKey($entry.Name)) { throw 'Unreviewed driver package contents.' }
  }
  foreach ($target in @($SetupPath, (Join-Path $root $catalogs[0]))) {
    $signature = & $SignatureReader $target
    if (-not $signature -or $signature.Status -cne 'Valid' -or $signature.Thumbprint -isnot [string] -or
      $signature.Thumbprint -notmatch '^[A-Fa-f0-9]{40,64}$' -or $signature.Thumbprint.ToUpperInvariant() -notin $allowed) {
      throw 'Driver signature is not valid and pinned.'
    }
  }
  return $true
}

function Invoke-VerifiedDriverSetup {
  param([string]$SetupPath, [string]$InfPath, [string]$PolicyPath,
    [scriptblock]$SignatureReader = { param($target) Get-BoundedDriverSignature $target },
    [scriptblock]$Launch = {
      param($target)
      $process = Start-Process -FilePath $target -ArgumentList @('-i', '-h') -WorkingDirectory (Split-Path -Parent $target) -WindowStyle Hidden -PassThru
      if (-not $process.WaitForExit(300000)) { $process.Kill(); throw 'Driver installation timed out.' }
      return [int]$process.ExitCode
    })
  $verified = Assert-VerifiedDriverPackage $SetupPath $InfPath $PolicyPath $SignatureReader
  if ($verified -isnot [bool] -or $verified -ne $true) { throw 'Unexpected verification result.' }
  $exitCode = & $Launch $SetupPath
  if ($exitCode -isnot [int]) { throw 'Malformed installation result.' }
  return $exitCode
}
