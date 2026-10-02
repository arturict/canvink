[CmdletBinding()]
param(
  [ValidateSet('Preflight', 'Sign', 'Verify', 'VerifyBundle')]
  [string] $Mode = 'Preflight',
  [string[]] $TargetPath = @(),
  [string] $BundleRoot = 'src-tauri/target/release/bundle',
  [string] $ApplicationExecutable = 'src-tauri/target/release/Canvink.exe'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Set-Variable -Name CODE_SIGNING_EKU -Value '1.3.6.1.5.5.7.3.3' -Option Constant

function Stop-Signing {
  param([Parameter(Mandatory)][string] $Message)
  [Console]::Error.WriteLine("[signing] BLOCKED: $Message")
  exit 3
}

function Get-NormalizedThumbprint {
  param([Parameter(Mandatory)][string] $Value)
  $normalized = ($Value -replace '\s', '').ToUpperInvariant()
  if ($normalized -notmatch '^[0-9A-F]{40}$') {
    Stop-Signing 'certificate thumbprint must contain exactly 40 hexadecimal characters'
  }
  return $normalized
}

function Get-SigningConfiguration {
  if ($env:CANVINK_WINDOWS_SIGNED -ne '1') {
    Stop-Signing 'signed mode was not explicitly requested'
  }
  if ($env:CANVINK_WINDOWS_SIGN_PROVIDER -ne 'windows-store') {
    Stop-Signing 'CANVINK_WINDOWS_SIGN_PROVIDER must be windows-store'
  }
  if ([string]::IsNullOrWhiteSpace($env:CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT)) {
    Stop-Signing 'CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT is required'
  }
  if ([string]::IsNullOrWhiteSpace($env:CANVINK_WINDOWS_TIMESTAMP_URL)) {
    Stop-Signing 'CANVINK_WINDOWS_TIMESTAMP_URL is required'
  }
  $timestampUri = $null
  if (-not [Uri]::TryCreate(
    $env:CANVINK_WINDOWS_TIMESTAMP_URL,
    [UriKind]::Absolute,
    [ref] $timestampUri
  ) -or $timestampUri.Scheme -ne 'https') {
    Stop-Signing 'timestamp URL must be an absolute HTTPS URL'
  }
  return @{
    Thumbprint = Get-NormalizedThumbprint $env:CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT
    TimestampUrl = $timestampUri.AbsoluteUri
  }
}

function Get-SignTool {
  if (-not [string]::IsNullOrWhiteSpace($env:CANVINK_SIGNTOOL_PATH)) {
    $candidate = [IO.Path]::GetFullPath($env:CANVINK_SIGNTOOL_PATH)
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      Stop-Signing 'configured SignTool executable is unavailable'
    }
    return $candidate
  }
  $command = Get-Command 'signtool.exe' -CommandType Application -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    return $command.Source
  }
  $kitsRoot = if (${env:ProgramFiles(x86)}) {
    Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  } else {
    $null
  }
  if ($kitsRoot -and (Test-Path -LiteralPath $kitsRoot -PathType Container)) {
    $candidate = Get-ChildItem -LiteralPath $kitsRoot -Directory |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1
    if ($candidate) {
      return $candidate
    }
  }
  Stop-Signing 'SignTool from the Windows SDK is required'
}

function Get-SigningCertificate {
  param(
    [Parameter(Mandatory)][string] $Thumbprint,
    [bool] $RequirePrivateKey = $true
  )
  $matches = @()
  foreach ($storeLocation in @('CurrentUser', 'LocalMachine')) {
    $certificatePath = "Cert:\$storeLocation\My\$Thumbprint"
    if (Test-Path -LiteralPath $certificatePath) {
      $matches += [pscustomobject]@{
        Certificate = Get-Item -LiteralPath $certificatePath
        StoreLocation = $storeLocation
      }
    }
  }
  if ($matches.Count -ne 1) {
    Stop-Signing 'exactly one matching certificate is required in a Windows Personal store'
  }
  $certificate = $matches[0].Certificate
  $now = [DateTime]::UtcNow
  if ($certificate.NotBefore.ToUniversalTime() -gt $now) {
    Stop-Signing 'the signing certificate is not valid yet'
  }
  if ($certificate.NotAfter.ToUniversalTime() -le $now) {
    Stop-Signing 'the signing certificate is expired'
  }
  if ($RequirePrivateKey -and -not $certificate.HasPrivateKey) {
    Stop-Signing 'the signing certificate has no accessible private key'
  }
  $ekuValues = @($certificate.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId.Value })
  if ($ekuValues -notcontains $CODE_SIGNING_EKU) {
    Stop-Signing 'the certificate does not have the Code Signing EKU'
  }
  $keyUsage = $certificate.Extensions |
    Where-Object { $_.Oid.Value -eq '2.5.29.15' } |
    Select-Object -First 1
  if (
    $null -ne $keyUsage -and
    ($keyUsage.KeyUsages -band [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature) -eq 0
  ) {
    Stop-Signing 'the certificate key usage does not permit digital signatures'
  }
  $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
  try {
    $chain.ChainPolicy.RevocationMode =
      [Security.Cryptography.X509Certificates.X509RevocationMode]::Online
    $chain.ChainPolicy.RevocationFlag =
      [Security.Cryptography.X509Certificates.X509RevocationFlag]::EntireChain
    $chain.ChainPolicy.VerificationFlags =
      [Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
    $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(20)
    if (-not $chain.Build($certificate)) {
      $statuses = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() }) -join ', '
      Stop-Signing "the certificate chain is not currently trusted and valid ($statuses)"
    }
  } finally {
    $chain.Dispose()
  }
  return $matches[0]
}

function Assert-SignableTarget {
  param([Parameter(Mandatory)][string] $Value)
  $resolved = Resolve-Path -LiteralPath $Value -ErrorAction SilentlyContinue
  if ($null -eq $resolved -or -not (Test-Path -LiteralPath $resolved.Path -PathType Leaf)) {
    Stop-Signing 'signing target does not exist'
  }
  if ([IO.Path]::GetExtension($resolved.Path).ToLowerInvariant() -notin @('.exe', '.msi')) {
    Stop-Signing 'only EXE and MSI Authenticode targets are accepted'
  }
  return $resolved.Path
}

function Invoke-SignTool {
  param(
    [Parameter(Mandatory)][string] $SignTool,
    [Parameter(Mandatory)][string[]] $Arguments,
    [Parameter(Mandatory)][string] $Operation
  )
  & $SignTool @Arguments 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) {
    Stop-Signing "$Operation failed (SignTool exit $LASTEXITCODE)"
  }
}

function Assert-AuthenticodeSignature {
  param(
    [Parameter(Mandatory)][string] $Value,
    [Parameter(Mandatory)][string] $ExpectedThumbprint,
    [Parameter(Mandatory)][string] $SignTool
  )
  $target = Assert-SignableTarget $Value
  $signature = Get-AuthenticodeSignature -LiteralPath $target
  if ($signature.Status -ne 'Valid') {
    Stop-Signing "Authenticode status is not Valid for $([IO.Path]::GetFileName($target))"
  }
  if ($null -eq $signature.SignerCertificate) {
    Stop-Signing "signer certificate is missing for $([IO.Path]::GetFileName($target))"
  }
  if ((Get-NormalizedThumbprint $signature.SignerCertificate.Thumbprint) -ne $ExpectedThumbprint) {
    Stop-Signing "unexpected signer certificate for $([IO.Path]::GetFileName($target))"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    Stop-Signing "RFC 3161 timestamp is missing for $([IO.Path]::GetFileName($target))"
  }
  Invoke-SignTool `
    -SignTool $SignTool `
    -Arguments @('verify', '/q', '/pa', '/all', $target) `
    -Operation "signature verification for $([IO.Path]::GetFileName($target))"
  [Console]::WriteLine("[signing] VERIFIED $([IO.Path]::GetFileName($target))")
}

$configuration = Get-SigningConfiguration
$certificateMatch = Get-SigningCertificate -Thumbprint $configuration.Thumbprint
$signTool = Get-SignTool

if ($Mode -eq 'Preflight') {
  [Console]::WriteLine('[signing] READY trusted Windows code-signing certificate and SignTool verified')
  exit 0
}

if ($Mode -eq 'Sign') {
  if ($TargetPath.Count -ne 1) {
    Stop-Signing 'Tauri signing hook requires exactly one target'
  }
  $target = Assert-SignableTarget $TargetPath[0]
  $arguments = @('sign', '/q', '/fd', 'SHA256', '/td', 'SHA256', '/tr', $configuration.TimestampUrl)
  if ($certificateMatch.StoreLocation -eq 'LocalMachine') {
    $arguments += '/sm'
  }
  $arguments += @('/s', 'My', '/sha1', $configuration.Thumbprint, '/u', $CODE_SIGNING_EKU, $target)
  Invoke-SignTool -SignTool $signTool -Arguments $arguments -Operation 'signing or timestamping'
  Assert-AuthenticodeSignature $target $configuration.Thumbprint $signTool
  exit 0
}

if ($Mode -eq 'VerifyBundle') {
  $resolvedBundle = Resolve-Path -LiteralPath $BundleRoot -ErrorAction SilentlyContinue
  if ($null -eq $resolvedBundle) {
    Stop-Signing 'Windows bundle directory does not exist'
  }
  $targets = @(
    Get-ChildItem -LiteralPath $resolvedBundle.Path -Recurse -File |
      Where-Object { $_.Extension.ToLowerInvariant() -in @('.exe', '.msi') } |
      ForEach-Object { $_.FullName }
  )
  if (Test-Path -LiteralPath $ApplicationExecutable -PathType Leaf) {
    $targets += (Resolve-Path -LiteralPath $ApplicationExecutable).Path
  }
  $TargetPath = @($targets | Sort-Object -Unique)
}

if ($TargetPath.Count -eq 0) {
  Stop-Signing 'at least one signed target is required for verification'
}
foreach ($target in $TargetPath) {
  Assert-AuthenticodeSignature $target $configuration.Thumbprint $signTool
}
