param(
  [Parameter(Mandatory = $true)]
  [string]$SetupPath,

  [Parameter(Mandatory = $true)]
  [string]$InfPath,

  [string]$LogPath = "$env:ProgramData\freqx\vbcable-install.log"
)

$ErrorActionPreference = "Stop"

function Write-InstallLog {
  param([string]$Message)

  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Output $line

  try {
    $logDirectory = Split-Path -Parent $LogPath
    if ($logDirectory) {
      New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    }
    Add-Content -LiteralPath $LogPath -Value $line
  } catch {
  }
}

function Get-CatalogPath {
  param([string]$DriverInfPath)

  $driverDirectory = Split-Path -Parent $DriverInfPath
  $catalogLine = Get-Content -LiteralPath $DriverInfPath |
    Where-Object { $_ -match '^\s*CatalogFile\s*=' } |
    Select-Object -First 1

  if ($catalogLine -and $catalogLine -match '^\s*CatalogFile\s*=\s*(.+?)\s*$') {
    $catalogName = $Matches[1].Trim().Trim('"')
    $catalogPath = Join-Path $driverDirectory $catalogName
    if (Test-Path -LiteralPath $catalogPath -PathType Leaf) {
      return $catalogPath
    }
  }

  $fallbackCatalog = Get-ChildItem -LiteralPath $driverDirectory -Filter "*.cat" -File |
    Sort-Object Name |
    Select-Object -First 1

  if ($fallbackCatalog) {
    return $fallbackCatalog.FullName
  }

  return $null
}

function Add-TrustedPublisherCertificate {
  param([string]$CatalogPath)

  $signature = Get-AuthenticodeSignature -LiteralPath $CatalogPath
  if (-not $signature.SignerCertificate) {
    throw "No signer certificate was found in $CatalogPath."
  }

  if ($signature.Status -ne "Valid") {
    Write-InstallLog "Catalog signature status is $($signature.Status): $($signature.StatusMessage)"
  }

  $certificate = $signature.SignerCertificate
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("TrustedPublisher", "LocalMachine")
  $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)

  try {
    $existing = $store.Certificates | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint } | Select-Object -First 1
    if ($existing) {
      Write-InstallLog "VB-CABLE publisher certificate is already trusted: $($certificate.Subject)"
      return $false
    }

    Write-InstallLog "Temporarily trusting VB-CABLE publisher certificate: $($certificate.Subject)"
    $store.Add($certificate)
    return $true
  } finally {
    $store.Close()
  }
}

function Remove-TrustedPublisherCertificate {
  param([string]$CatalogPath)

  try {
    $signature = Get-AuthenticodeSignature -LiteralPath $CatalogPath
    if (-not $signature.SignerCertificate) {
      return
    }

    $certificate = $signature.SignerCertificate
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("TrustedPublisher", "LocalMachine")
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)

    try {
      $matches = $store.Certificates | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint }
      foreach ($match in $matches) {
        $store.Remove($match)
      }
      Write-InstallLog "Removed temporary VB-CABLE publisher trust: $($certificate.Subject)"
    } finally {
      $store.Close()
    }
  } catch {
    Write-InstallLog "Could not remove temporary publisher trust: $($_.Exception.Message)"
  }
}

try {
  Write-InstallLog "Starting VB-CABLE silent setup install."
  Write-InstallLog "Setup path: $SetupPath"
  Write-InstallLog "INF path: $InfPath"

  if (-not (Test-Path -LiteralPath $SetupPath -PathType Leaf)) {
    Write-InstallLog "VB-CABLE setup was not found."
    exit 2
  }

  if (-not (Test-Path -LiteralPath $InfPath -PathType Leaf)) {
    Write-InstallLog "VB-CABLE INF was not found."
    exit 2
  }

  $packageDirectory = Split-Path -Parent $SetupPath
  $catalogPath = Get-CatalogPath -DriverInfPath $InfPath
  if (-not $catalogPath) {
    Write-InstallLog "No catalog file was found beside the VB-CABLE INF."
    exit 3
  }

  Write-InstallLog "Catalog path: $catalogPath"
  $addedTemporaryTrust = Add-TrustedPublisherCertificate -CatalogPath $catalogPath

  try {
    Write-InstallLog "Running VB-CABLE setup with -i -h."
    $process = Start-Process `
      -FilePath $SetupPath `
      -ArgumentList @("-i", "-h") `
      -WorkingDirectory $packageDirectory `
      -WindowStyle Hidden `
      -Wait `
      -PassThru

    $exitCode = [int]$process.ExitCode
    Write-InstallLog "VB-CABLE setup exited with code $exitCode."
    exit $exitCode
  } finally {
    if ($addedTemporaryTrust) {
      Remove-TrustedPublisherCertificate -CatalogPath $catalogPath
    }
  }
} catch {
  Write-InstallLog "Unhandled error: $($_.Exception.Message)"
  exit 1
}
