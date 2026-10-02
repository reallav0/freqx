param(
  [Parameter(Mandatory = $true)][string]$SetupPath,
  [Parameter(Mandatory = $true)][string]$InfPath,
  [string]$LogPath = "$env:ProgramData\freqx\vbcable-install.log"
)
$ErrorActionPreference = 'Stop'
try {
  . (Join-Path $PSScriptRoot 'driver-verification.ps1')
  $result = Invoke-VerifiedDriverSetup -SetupPath $SetupPath -InfPath $InfPath -PolicyPath (Join-Path $PSScriptRoot 'driver-policy.json')
  exit $result
} catch {
  $message = "Driver installation blocked: $($_.Exception.Message)"
  Write-Output $message
  try { Add-Content -LiteralPath $LogPath -Value $message -ErrorAction Stop } catch {}
  exit 1
}
