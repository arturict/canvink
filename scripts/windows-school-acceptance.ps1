[CmdletBinding()]
param(
  [ValidateSet('Preflight', 'AutomatedTests', 'LaunchBuiltApp', 'Checklist', 'ValidatePenPerformance')]
  [string] $Mode = 'Preflight',
  [string] $OutputPath = 'test-results/windows-school-acceptance.json',
  [string] $ProbeFixturePath = '',
  [string] $EvidenceRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Set-Variable -Name PEN_HARDWARE_IDS -Value @(
  'HID_DEVICE_UP:000D_U:0001',
  'HID_DEVICE_UP:000D_U:0002'
) -Option Constant
Set-Variable -Name CODE_SIGNING_EKU -Value '1.3.6.1.5.5.7.3.3' -Option Constant
Set-Variable -Name EVIDENCE_MAX_AGE_DAYS -Value 7 -Option Constant
Set-Variable -Name REQUIRED_ENVIRONMENT -Value ([ordered]@{
  entra = @('VITE_MICROSOFT_CLIENT_ID', 'VITE_MICROSOFT_REDIRECT_URI')
  appwrite = @('APPWRITE_FUNCTION_API_ENDPOINT', 'APPWRITE_FUNCTION_PROJECT_ID', 'CANVINK_ALLOWED_ORIGINS')
  signing = @(
    'CANVINK_WINDOWS_SIGNED',
    'CANVINK_WINDOWS_SIGN_PROVIDER',
    'CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT',
    'CANVINK_WINDOWS_TIMESTAMP_URL'
  )
}) -Option Constant
Set-Variable -Name EXPECTED_EVIDENCE -Value ([ordered]@{
  checklist = 'test-results/personal-acceptance/checklist.json'
  penPerformance = 'test-results/personal-acceptance/pen-performance.json'
  penSession = 'test-results/personal-acceptance/pen-session-45m.json'
  personalPdf = 'test-results/personal-acceptance/personal-pdf.json'
  personalOneNote = 'test-results/personal-acceptance/personal-onenote.json'
  personalOcr = 'test-results/personal-acceptance/personal-ocr.json'
  collaboration = 'test-results/personal-acceptance/collaboration-2-account.json'
  dpapiRestart = 'test-results/personal-acceptance/dpapi-restart.json'
  encryptedBackupRestore = 'test-results/personal-acceptance/encrypted-backup-restore.json'
  trustedSignedArtifact = 'test-results/personal-acceptance/trusted-signed-artifact.json'
  syncSoak = 'test-results/sync-soak-automerge-simulation-60m.json'
}) -Option Constant

function Test-PresentEnvironment {
  param([Parameter(Mandatory)][string] $Name)
  return -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name))
}

function Get-EnvironmentPresence {
  $groups = [ordered]@{}
  foreach ($groupName in $REQUIRED_ENVIRONMENT.Keys) {
    $entries = [ordered]@{}
    foreach ($name in $REQUIRED_ENVIRONMENT[$groupName]) {
      $entries[$name] = [ordered]@{ present = Test-PresentEnvironment $name }
    }
    $groups[$groupName] = $entries
  }
  return $groups
}

function Test-PenHardwareIds {
  param([AllowEmptyCollection()][object[]] $Devices)
  $matches = 0
  foreach ($device in @($Devices)) {
    if ($null -eq $device) { continue }
    $present = if ($device.PSObject.Properties.Name -contains 'present') { [bool]$device.present } else { $true }
    $pnpClass = if ($device.PSObject.Properties.Name -contains 'pnpClass') { [string]$device.pnpClass } else { '' }
    if (-not $present -or $pnpClass -ne 'HIDClass') { continue }
    $matchedDevice = $false
    foreach ($hardwareId in @($device.hardwareIds)) {
      if ($PEN_HARDWARE_IDS -contains ([string]$hardwareId).ToUpperInvariant()) {
        $matchedDevice = $true
        break
      }
    }
    if ($matchedDevice) { $matches += 1 }
  }
  return [ordered]@{
    present = $matches -gt 0
    matchingDeviceCount = $matches
    detection = 'exact-hid-digitizer-usage-id'
  }
}

function Get-LivePenProbe {
  $devices = @()
  try {
    $devices = @(Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction Stop |
      Where-Object { $_.PNPClass -eq 'HIDClass' -and $_.ConfigManagerErrorCode -eq 0 } |
      ForEach-Object {
        [pscustomobject]@{
          present = $true
          pnpClass = 'HIDClass'
          hardwareIds = @($_.HardwareID)
        }
      })
  } catch {
    $devices = @()
  }
  return Test-PenHardwareIds $devices
}

function Get-WindowsProbe {
  try {
    $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    return [ordered]@{
      productName = [string]$operatingSystem.Caption
      version = [string]$operatingSystem.Version
      build = [string]$operatingSystem.BuildNumber
    }
  } catch {
    return [ordered]@{ productName = 'Windows'; version = ''; build = '' }
  }
}

function Get-OcrProbe {
  $languageTags = @()
  $runtimeAvailable = $false
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    $runtimeAvailable = $true
    $languageTags = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages |
      ForEach-Object { [string]$_.LanguageTag } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Sort-Object -Unique)
  } catch {
    $runtimeAvailable = $false
    $languageTags = @()
  }
  return [ordered]@{
    runtimeAvailable = $runtimeAvailable
    installedLanguageTags = $languageTags
    installedLanguageCount = $languageTags.Count
  }
}

function Get-OneNoteProbe {
  $appx = $false
  $win32 = $false
  try { $appx = @(Get-AppxPackage -Name 'Microsoft.Office.OneNote' -ErrorAction Stop).Count -gt 0 } catch { $appx = $false }
  foreach ($key in @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ONENOTE.EXE',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\ONENOTE.EXE',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ONENOTE.EXE'
  )) {
    if (-not (Test-Path -LiteralPath $key)) { continue }
    try {
      $registryKey = Get-Item -LiteralPath $key -ErrorAction Stop
      $executable = [string]$registryKey.GetValue('')
      if (-not [string]::IsNullOrWhiteSpace($executable) -and (Test-Path -LiteralPath $executable -PathType Leaf)) {
        $win32 = $true
        break
      }
    } catch { $win32 = $false }
  }
  return [ordered]@{ available = $appx -or $win32; appx = $appx; win32 = $win32 }
}

function Get-CertificateProbe {
  $total = 0
  $codeSigning = 0
  $validWithPrivateKey = 0
  $locallyTrusted = 0
  $configuredMatches = 0
  $configuredThumbprint = [Environment]::GetEnvironmentVariable('CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT')
  $normalizedConfigured = if ([string]::IsNullOrWhiteSpace($configuredThumbprint)) {
    ''
  } else {
    ($configuredThumbprint -replace '\s', '').ToUpperInvariant()
  }
  foreach ($storePath in @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\My')) {
    foreach ($certificate in @(Get-ChildItem -LiteralPath $storePath -ErrorAction SilentlyContinue)) {
      $total += 1
      if (([string]$certificate.Thumbprint).ToUpperInvariant() -eq $normalizedConfigured) { $configuredMatches += 1 }
      $ekuProperty = $certificate.PSObject.Properties['EnhancedKeyUsageList']
      $ekuValues = if ($null -eq $ekuProperty) { @() } else {
        @($ekuProperty.Value | ForEach-Object {
          if ($null -eq $_) { return }
          $objectIdProperty = $_.PSObject.Properties['ObjectId']
          $valueProperty = $_.PSObject.Properties['Value']
          if ($null -ne $objectIdProperty -and $null -ne $objectIdProperty.Value) {
            $nestedValue = $objectIdProperty.Value.PSObject.Properties['Value']
            if ($null -ne $nestedValue) { $nestedValue.Value }
          } elseif ($null -ne $valueProperty) {
            $valueProperty.Value
          }
        })
      }
      if ($ekuValues -notcontains $CODE_SIGNING_EKU) { continue }
      $codeSigning += 1
      $now = [DateTime]::UtcNow
      $valid = $certificate.NotBefore.ToUniversalTime() -le $now -and $certificate.NotAfter.ToUniversalTime() -gt $now
      if ($valid -and $certificate.HasPrivateKey) { $validWithPrivateKey += 1 }
      if ($valid) {
        $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
        try {
          $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
          if ($chain.Build($certificate)) { $locallyTrusted += 1 }
        } finally {
          $chain.Dispose()
        }
      }
    }
  }
  return [ordered]@{
    personalStoreCertificateCount = $total
    codeSigningCertificateCount = $codeSigning
    validCodeSigningWithPrivateKeyCount = $validWithPrivateKey
    locallyTrustedCodeSigningCount = $locallyTrusted
    configuredCertificateMatchCount = $configuredMatches
    ready = $validWithPrivateKey -gt 0 -and $locallyTrusted -gt 0 -and $configuredMatches -eq 1
  }
}

function Get-AppwriteConfigProbe {
  $path = Join-Path $PSScriptRoot '..\appwrite.config.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    return [ordered]@{ filePresent = $false; projectConfigured = $false; endpointConfigured = $false; resourceFilesPresent = $false }
  }
  try {
    $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $projectConfigured = -not [string]::IsNullOrWhiteSpace([string]$config.projectId) -and [string]$config.projectId -notmatch '^<.*>$'
    $endpointConfigured = -not [string]::IsNullOrWhiteSpace([string]$config.endpoint) -and [string]$config.endpoint -notmatch '<.*>'
    $resourceFilesPresent = $true
    $repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    foreach ($includeName in @('functions', 'tablesDB', 'tables', 'buckets')) {
      $includeProperty = $config.includes.PSObject.Properties[$includeName]
      if ($null -eq $includeProperty -or [string]::IsNullOrWhiteSpace([string]$includeProperty.Value)) {
        $resourceFilesPresent = $false
        continue
      }
      $includePath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot ([string]$includeProperty.Value)))
      if (-not (Test-Path -LiteralPath $includePath -PathType Leaf)) { $resourceFilesPresent = $false }
    }
    return [ordered]@{
      filePresent = $true
      projectConfigured = $projectConfigured
      endpointConfigured = $endpointConfigured
      resourceFilesPresent = $resourceFilesPresent
    }
  } catch {
    return [ordered]@{ filePresent = $true; projectConfigured = $false; endpointConfigured = $false; resourceFilesPresent = $false }
  }
}

function Test-NumericValue {
  param([AllowNull()]$Value)
  return $Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or $Value -is [uint16] -or
    $Value -is [int32] -or $Value -is [uint32] -or $Value -is [int64] -or $Value -is [uint64] -or
    $Value -is [single] -or $Value -is [double] -or $Value -is [decimal]
}

function Assert-ExactProperties {
  param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string[]]$Names)
  if ($null -eq $Value -or $Value -isnot [psobject]) { throw 'shape' }
  $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
  $expected = @($Names | Sort-Object)
  if ($actual.Count -ne $expected.Count -or @(Compare-Object $actual $expected).Count -ne 0) { throw 'shape' }
}

function Test-TrueBoolean {
  param([AllowNull()]$Value)
  return $Value -is [bool] -and $Value
}

function Assert-PositiveInteger {
  param([AllowNull()]$Value, [int]$Minimum = 1)
  if (-not (Test-NumericValue $Value) -or [double]$Value % 1 -ne 0 -or [int64]$Value -lt $Minimum) { throw 'value' }
}

function ConvertFrom-StrictUtcTimestamp {
  param([AllowNull()]$Value)
  $parsed = [DateTimeOffset]::MinValue
  if (
    [string]$Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,7})?Z$' -or
    -not [DateTimeOffset]::TryParse(
      [string]$Value,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$parsed
    )
  ) { throw 'timestamp' }
  return $parsed
}

function Get-RepositoryBinding {
  $packagePath = Join-Path $PSScriptRoot '..\package.json'
  $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
  $commit = (& git rev-parse HEAD 2>$null | Select-Object -First 1)
  if ([string]$commit -notmatch '^[0-9a-f]{40}$') { throw 'repository binding unavailable' }
  if ([string]$package.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'package binding unavailable' }
  return [ordered]@{ repositoryCommit = [string]$commit; packageVersion = [string]$package.version }
}

function Assert-EvidenceEnvelope {
  param(
    [Parameter(Mandatory)]$Artifact,
    [Parameter(Mandatory)][string]$Kind,
    [Parameter(Mandatory)][string]$Producer,
    [Parameter(Mandatory)]$Binding
  )
  Assert-ExactProperties $Artifact @(
    'schemaVersion', 'kind', 'contentFree', 'repositoryCommit', 'packageVersion',
    'recordedAt', 'status', 'producer', 'results'
  )
  if (-not (Test-NumericValue $Artifact.schemaVersion) -or [int]$Artifact.schemaVersion -ne 1) { throw 'schema' }
  if ([string]$Artifact.kind -ne $Kind -or [string]$Artifact.producer -ne $Producer) { throw 'manual-or-kind' }
  if (-not (Test-TrueBoolean $Artifact.contentFree) -or [string]$Artifact.status -ne 'passed') { throw 'status' }
  if ([string]$Artifact.repositoryCommit -ne $Binding.repositoryCommit -or [string]$Artifact.packageVersion -ne $Binding.packageVersion) {
    throw 'binding'
  }
  $recordedAt = ConvertFrom-StrictUtcTimestamp $Artifact.recordedAt
  $now = [DateTimeOffset]::UtcNow
  if ($recordedAt -gt $now.AddMinutes(5) -or $recordedAt -lt $now.AddDays(-$EVIDENCE_MAX_AGE_DAYS)) { throw 'stale' }
}

function Assert-EvidenceResults {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)]$Results)
  switch ($Name) {
    'penPerformance' {
      Assert-ExactProperties $Results @(
        'sampleCount', 'p95Ms', 'thresholdMs', 'durationMinutes',
        'sessionStartedAt', 'sessionEndedAt', 'sessionObservedThrough', 'samples'
      )
      Assert-PositiveInteger $Results.sampleCount 20
      if (-not (Test-NumericValue $Results.p95Ms) -or [double]$Results.p95Ms -lt 0 -or [double]$Results.p95Ms -ge 20) { throw 'value' }
      if (-not (Test-NumericValue $Results.thresholdMs) -or [double]$Results.thresholdMs -ne 20) { throw 'value' }
      if (-not (Test-NumericValue $Results.durationMinutes) -or [double]$Results.durationMinutes -ne 45) { throw 'value' }
      $startedAt = ConvertFrom-StrictUtcTimestamp $Results.sessionStartedAt
      $endedAt = ConvertFrom-StrictUtcTimestamp $Results.sessionEndedAt
      $observedThrough = ConvertFrom-StrictUtcTimestamp $Results.sessionObservedThrough
      if (($endedAt - $startedAt).TotalMilliseconds -ne 2700000 -or $observedThrough -lt $endedAt) { throw 'value' }
      $samples = @($Results.samples)
      if ($samples.Count -ne [int]$Results.sampleCount -or $samples.Count -gt 20000) { throw 'value' }
      $durations = [Collections.Generic.List[double]]::new()
      $previousTimestamp = [DateTimeOffset]::MinValue
      foreach ($sample in $samples) {
        Assert-ExactProperties $sample @('durationMs', 'recordedAt')
        if (-not (Test-NumericValue $sample.durationMs) -or [double]$sample.durationMs -lt 0 -or [double]$sample.durationMs -gt 60000) { throw 'value' }
        $sampleTimestamp = ConvertFrom-StrictUtcTimestamp $sample.recordedAt
        if ($sampleTimestamp -lt $startedAt -or $sampleTimestamp -gt $endedAt -or $sampleTimestamp -lt $previousTimestamp) { throw 'value' }
        $previousTimestamp = $sampleTimestamp
        $durations.Add([double]$sample.durationMs)
      }
      $sorted = @($durations | Sort-Object)
      $p95Index = [Math]::Max(0, [Math]::Ceiling(0.95 * $sorted.Count) - 1)
      $computedP95 = [double]$sorted[$p95Index]
      if ([Math]::Abs($computedP95 - [double]$Results.p95Ms) -gt 0.000000001) { throw 'value' }
    }
    'penSession' {
      Assert-ExactProperties $Results @('durationMinutes', 'completedWithoutDataLoss')
      if (-not (Test-NumericValue $Results.durationMinutes) -or [double]$Results.durationMinutes -ne 45) { throw 'value' }
      if (-not (Test-TrueBoolean $Results.completedWithoutDataLoss)) { throw 'value' }
    }
    'personalPdf' {
      Assert-ExactProperties $Results @('filesTested', 'pageCount', 'integrityVerified', 'assetsReloaded', 'crdtReloaded', 'exportVerified')
      Assert-PositiveInteger $Results.filesTested; Assert-PositiveInteger $Results.pageCount
      foreach ($field in @('integrityVerified', 'assetsReloaded', 'crdtReloaded', 'exportVerified')) {
        if (-not (Test-TrueBoolean $Results.$field)) { throw 'value' }
      }
    }
    'personalOneNote' {
      Assert-ExactProperties $Results @('pagesTested', 'delegatedScope', 'additiveImportVerified', 'rollbackVerified', 'noWritePermission')
      Assert-PositiveInteger $Results.pagesTested
      if ([string]$Results.delegatedScope -ne 'Notes.Read') { throw 'value' }
      foreach ($field in @('additiveImportVerified', 'rollbackVerified', 'noWritePermission')) {
        if (-not (Test-TrueBoolean $Results.$field)) { throw 'value' }
      }
    }
    'personalOcr' {
      Assert-ExactProperties $Results @('samplesTested', 'installedLanguageCount', 'localOnlyVerified', 'rotationVerified', 'boundsVerified')
      Assert-PositiveInteger $Results.samplesTested; Assert-PositiveInteger $Results.installedLanguageCount
      foreach ($field in @('localOnlyVerified', 'rotationVerified', 'boundsVerified')) {
        if (-not (Test-TrueBoolean $Results.$field)) { throw 'value' }
      }
    }
    'collaboration' {
      Assert-ExactProperties $Results @('accountCount', 'sessionMinutes', 'encryptedTransportVerified', 'offlineCatchupVerified', 'rolesVerified', 'revocationVerified')
      Assert-PositiveInteger $Results.accountCount 2; Assert-PositiveInteger $Results.sessionMinutes
      foreach ($field in @('encryptedTransportVerified', 'offlineCatchupVerified', 'rolesVerified', 'revocationVerified')) {
        if (-not (Test-TrueBoolean $Results.$field)) { throw 'value' }
      }
    }
    'dpapiRestart' {
      Assert-ExactProperties $Results @('restartCount', 'protectedReopenVerified', 'wrongIdentityDenied')
      Assert-PositiveInteger $Results.restartCount
      if (-not (Test-TrueBoolean $Results.protectedReopenVerified) -or -not (Test-TrueBoolean $Results.wrongIdentityDenied)) { throw 'value' }
    }
    'encryptedBackupRestore' {
      Assert-ExactProperties $Results @('bundleFormatVersion', 'assetCount', 'crdtDocumentCount', 'integrityVerified', 'reloadVerified', 'guardedRollbackVerified')
      if (-not (Test-NumericValue $Results.bundleFormatVersion) -or [int]$Results.bundleFormatVersion -ne 2) { throw 'value' }
      Assert-PositiveInteger $Results.assetCount; Assert-PositiveInteger $Results.crdtDocumentCount 2
      foreach ($field in @('integrityVerified', 'reloadVerified', 'guardedRollbackVerified')) {
        if (-not (Test-TrueBoolean $Results.$field)) { throw 'value' }
      }
    }
    'trustedSignedArtifact' {
      Assert-ExactProperties $Results @('artifactCount', 'authenticodeStatus', 'timestampStatus', 'signerTrustStatus')
      Assert-PositiveInteger $Results.artifactCount 2
      if ([string]$Results.authenticodeStatus -ne 'Valid' -or [string]$Results.timestampStatus -ne 'Valid' -or [string]$Results.signerTrustStatus -ne 'Trusted') { throw 'value' }
    }
    'syncSoak' {
      Assert-ExactProperties $Results @('requestedMinutes', 'durationMs', 'clients', 'totalChanges', 'totalRetries', 'converged')
      if ([double]$Results.requestedMinutes -ne 60 -or [double]$Results.durationMs -lt 3600000 -or [int]$Results.clients -ne 20) { throw 'value' }
      Assert-PositiveInteger $Results.totalChanges
      if (-not (Test-NumericValue $Results.totalRetries) -or [int]$Results.totalRetries -lt 0 -or -not (Test-TrueBoolean $Results.converged)) { throw 'value' }
    }
    'checklist' {
      Assert-ExactProperties $Results @(
        'penSampleCount', 'penP95Ms', 'penSessionMinutes', 'personalPdf', 'personalOneNote',
        'personalOcr', 'collaborationAccountCount', 'collaboration', 'dpapiRestart',
        'encryptedBackupRestore', 'trustedSignedArtifact', 'syncSoak'
      )
      Assert-PositiveInteger $Results.penSampleCount 20
      if ([double]$Results.penP95Ms -ge 20 -or [double]$Results.penP95Ms -lt 0 -or [double]$Results.penSessionMinutes -ne 45) { throw 'value' }
      Assert-PositiveInteger $Results.collaborationAccountCount 2
      foreach ($field in @('personalPdf', 'personalOneNote', 'personalOcr', 'collaboration', 'dpapiRestart', 'encryptedBackupRestore', 'trustedSignedArtifact', 'syncSoak')) {
        if (-not (Test-TrueBoolean $Results.$field)) { throw 'value' }
      }
    }
    default { throw 'kind' }
  }
}

function Get-EvidenceDefinitions {
  return [ordered]@{
    checklist = [ordered]@{ kind = 'personal-acceptance-checklist'; producer = 'canvink-windows-acceptance-checklist-v1' }
    penPerformance = [ordered]@{ kind = 'pen-performance'; producer = 'canvink-performance-recorder' }
    penSession = [ordered]@{ kind = 'pen-session'; producer = 'canvink-pen-session-drill' }
    personalPdf = [ordered]@{ kind = 'personal-pdf'; producer = 'canvink-personal-pdf-drill' }
    personalOneNote = [ordered]@{ kind = 'personal-onenote'; producer = 'canvink-personal-onenote-drill' }
    personalOcr = [ordered]@{ kind = 'personal-ocr'; producer = 'canvink-personal-ocr-drill' }
    collaboration = [ordered]@{ kind = 'collaboration'; producer = 'canvink-live-collaboration-drill' }
    dpapiRestart = [ordered]@{ kind = 'dpapi-restart'; producer = 'canvink-dpapi-restart-drill' }
    encryptedBackupRestore = [ordered]@{ kind = 'encrypted-backup-restore'; producer = 'canvink-schema-v2-restore-drill' }
    trustedSignedArtifact = [ordered]@{ kind = 'trusted-signed-artifact'; producer = 'windows-authenticode-verifier' }
    syncSoak = [ordered]@{ kind = 'sync-soak'; producer = 'canvink-sync-soak-runner' }
  }
}

function Get-EvidenceActualPath {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][AllowEmptyString()][string]$TestRoot)
  if ([string]::IsNullOrWhiteSpace($TestRoot)) { return [IO.Path]::GetFullPath($EXPECTED_EVIDENCE[$Name]) }
  $expectedPath = [string]$EXPECTED_EVIDENCE[$Name]
  $leafName = [IO.Path]::GetFileName($expectedPath)
  return [IO.Path]::GetFullPath((Join-Path $TestRoot $leafName))
}

function Get-EvidenceProbe {
  param([Parameter(Mandatory)]$Binding, [Parameter(Mandatory)][AllowEmptyString()][string]$TestRoot)
  $definitions = Get-EvidenceDefinitions
  $report = [ordered]@{}
  $values = [ordered]@{}
  foreach ($name in $EXPECTED_EVIDENCE.Keys) {
    $path = Get-EvidenceActualPath $name $TestRoot
    $present = Test-Path -LiteralPath $path -PathType Leaf
    $valid = $false
    $reason = if ($present) { 'invalid' } else { 'missing' }
    if ($present) {
      try {
        $item = Get-Item -LiteralPath $path
        if ($item.Length -lt 2 -or $item.Length -gt 1048576) { throw 'size' }
        $artifact = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        Assert-EvidenceEnvelope $artifact $definitions[$name].kind $definitions[$name].producer $Binding
        Assert-EvidenceResults $name $artifact.results
        $values[$name] = $artifact.results
        $valid = $true
        $reason = 'validated'
      } catch {
        $reason = if ($_.Exception.Message -in @('shape', 'schema', 'manual-or-kind', 'status', 'binding', 'timestamp', 'stale', 'value', 'kind', 'size')) {
          $_.Exception.Message
        } else { 'malformed' }
      }
    }
    $report[$name] = [ordered]@{ expectedPath = $EXPECTED_EVIDENCE[$name]; present = $present; valid = $valid; validation = $reason }
  }
  if ($report.checklist.valid -and @($EXPECTED_EVIDENCE.Keys | Where-Object { -not $report[$_].valid }).Count -gt 0) {
    $report.checklist.valid = $false
    $report.checklist.validation = 'dependency-mismatch'
  }
  if ($report.checklist.valid) {
    $check = $values.checklist
    $matches =
      [int]$check.penSampleCount -eq [int]$values.penPerformance.sampleCount -and
      [double]$check.penP95Ms -eq [double]$values.penPerformance.p95Ms -and
      [double]$check.penSessionMinutes -eq [double]$values.penSession.durationMinutes -and
      [double]$check.penSessionMinutes -eq [double]$values.penPerformance.durationMinutes -and
      [int]$check.collaborationAccountCount -eq [int]$values.collaboration.accountCount
    if (-not $matches) { $report.checklist.valid = $false; $report.checklist.validation = 'dependency-mismatch' }
  }
  return [ordered]@{ report = $report; values = $values }
}

function Get-ChecklistProbe {
  param([Parameter(Mandatory)]$Evidence)
  if (-not $Evidence.report.checklist.valid) {
    return [ordered]@{ ingested = $false; valid = $false; sampleCount = 0; p95Ms = $null; penSessionMinutes = 0; collaborationAccountCount = 0 }
  }
  $results = $Evidence.values.checklist
  return [ordered]@{
    ingested = $true
    valid = $true
    sampleCount = [int]$results.penSampleCount
    p95Ms = [double]$results.penP95Ms
    penSessionMinutes = [double]$results.penSessionMinutes
    collaborationAccountCount = [int]$results.collaborationAccountCount
  }
}

function Convert-FixtureCertificates {
  param([AllowNull()]$Fixture)
  if ($null -eq $Fixture) { return $null }
  return [ordered]@{
    personalStoreCertificateCount = [int]$Fixture.personalStoreCertificateCount
    codeSigningCertificateCount = [int]$Fixture.codeSigningCertificateCount
    validCodeSigningWithPrivateKeyCount = [int]$Fixture.validCodeSigningWithPrivateKeyCount
    locallyTrustedCodeSigningCount = [int]$Fixture.locallyTrustedCodeSigningCount
    configuredCertificateMatchCount = [int]$Fixture.configuredCertificateMatchCount
    ready = [bool]$Fixture.ready
  }
}

function Invoke-OptionalPhase {
  param([Parameter(Mandatory)][string] $SelectedMode)
  if ($SelectedMode -eq 'AutomatedTests') {
    & pnpm check
    if ($LASTEXITCODE -ne 0) { throw 'automated acceptance command failed' }
    return [ordered]@{ requested = $true; completed = $true; command = 'pnpm check' }
  }
  if ($SelectedMode -eq 'LaunchBuiltApp') {
    $expected = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\target\release\Canvink.exe'))
    if (-not (Test-Path -LiteralPath $expected -PathType Leaf)) { throw 'the already-built Canvink executable is unavailable' }
    Start-Process -FilePath $expected -WorkingDirectory ([IO.Path]::GetDirectoryName($expected))
    return [ordered]@{ requested = $true; completed = $true; command = 'launch-built-canvink' }
  }
  return [ordered]@{ requested = $false; completed = $false; command = 'none' }
}

try {
  if ($Mode -eq 'ValidatePenPerformance') {
    if (-not [string]::IsNullOrWhiteSpace($EvidenceRoot) -and [Environment]::GetEnvironmentVariable('CANVINK_ACCEPTANCE_POLICY_TEST_MODE') -ne '1') {
      throw 'evidence root overrides are restricted to policy tests'
    }
    $binding = Get-RepositoryBinding
    $path = Get-EvidenceActualPath 'penPerformance' $EvidenceRoot
    $valid = $false
    $reason = if (Test-Path -LiteralPath $path -PathType Leaf) { 'invalid' } else { 'missing' }
    if ($reason -ne 'missing') {
      try {
        $item = Get-Item -LiteralPath $path
        if ($item.Length -lt 2 -or $item.Length -gt 1048576) { throw 'size' }
        $artifact = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        $definition = (Get-EvidenceDefinitions).penPerformance
        Assert-EvidenceEnvelope $artifact $definition.kind $definition.producer $binding
        Assert-EvidenceResults 'penPerformance' $artifact.results
        $valid = $true
        $reason = 'validated'
      } catch {
        $reason = if ($_.Exception.Message -in @('shape', 'schema', 'manual-or-kind', 'status', 'binding', 'timestamp', 'stale', 'value', 'kind', 'size')) {
          $_.Exception.Message
        } else { 'malformed' }
      }
    }
    $report = [ordered]@{
      schemaVersion = 1
      generatedAt = [DateTime]::UtcNow.ToString('o')
      mode = $Mode
      contentPolicy = 'aggregate-and-timings-only'
      repositoryBinding = $binding
      penPerformance = [ordered]@{ expectedPath = $EXPECTED_EVIDENCE.penPerformance; present = $reason -ne 'missing'; valid = $valid; validation = $reason }
      summary = [ordered]@{ status = if ($valid) { 'validated' } else { 'blocked' } }
    }
    $absoluteOutput = [IO.Path]::GetFullPath($OutputPath)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($absoluteOutput)) | Out-Null
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $absoluteOutput -Encoding UTF8
    [Console]::Out.WriteLine("[acceptance] pen-performance $($report.summary.status); content-free report written")
    if ($valid) { exit 0 }
    exit 2
  }

  $fixture = $null
  if (-not [string]::IsNullOrWhiteSpace($ProbeFixturePath)) {
    if ([Environment]::GetEnvironmentVariable('CANVINK_ACCEPTANCE_POLICY_TEST_MODE') -ne '1') {
      throw 'probe fixtures are restricted to policy tests'
    }
    if (-not (Test-Path -LiteralPath $ProbeFixturePath -PathType Leaf)) { throw 'probe fixture is unavailable' }
    $fixture = Get-Content -LiteralPath $ProbeFixturePath -Raw | ConvertFrom-Json
  }
  if (-not [string]::IsNullOrWhiteSpace($EvidenceRoot) -and $null -eq $fixture) {
    throw 'evidence root overrides are restricted to policy tests'
  }
  $binding = Get-RepositoryBinding

  $windows = if ($null -ne $fixture -and $fixture.PSObject.Properties.Name -contains 'windows') {
    [ordered]@{ productName = [string]$fixture.windows.productName; version = [string]$fixture.windows.version; build = [string]$fixture.windows.build }
  } else { Get-WindowsProbe }
  $pen = if ($null -ne $fixture -and $fixture.PSObject.Properties.Name -contains 'pnpDevices') {
    Test-PenHardwareIds @($fixture.pnpDevices)
  } else { Get-LivePenProbe }
  $ocr = if ($null -ne $fixture -and $fixture.PSObject.Properties.Name -contains 'ocr') {
    $tags = @($fixture.ocr.languageTags | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    [ordered]@{ runtimeAvailable = [bool]$fixture.ocr.runtimeAvailable; installedLanguageTags = $tags; installedLanguageCount = $tags.Count }
  } else { Get-OcrProbe }
  $oneNote = if ($null -ne $fixture -and $fixture.PSObject.Properties.Name -contains 'oneNote') {
    [ordered]@{ available = [bool]$fixture.oneNote.available; appx = [bool]$fixture.oneNote.appx; win32 = [bool]$fixture.oneNote.win32 }
  } else { Get-OneNoteProbe }
  $certificates = if ($null -ne $fixture -and $fixture.PSObject.Properties.Name -contains 'certificates') {
    Convert-FixtureCertificates $fixture.certificates
  } else { Get-CertificateProbe }
  $appwriteConfig = if ($null -ne $fixture -and $fixture.PSObject.Properties.Name -contains 'appwriteConfig') {
    [ordered]@{
      filePresent = [bool]$fixture.appwriteConfig.filePresent
      projectConfigured = [bool]$fixture.appwriteConfig.projectConfigured
      endpointConfigured = [bool]$fixture.appwriteConfig.endpointConfigured
      resourceFilesPresent = [bool]$fixture.appwriteConfig.resourceFilesPresent
    }
  } else { Get-AppwriteConfigProbe }
  $environment = Get-EnvironmentPresence
  $evidenceResult = Get-EvidenceProbe $binding $EvidenceRoot
  $evidence = $evidenceResult.report
  $checklist = if ($Mode -eq 'Checklist') { Get-ChecklistProbe $evidenceResult } else {
    [ordered]@{ ingested = $false; valid = $false; p95Ms = $null; sampleCount = 0; penSessionMinutes = 0; collaborationAccountCount = 0 }
  }
  $phase = Invoke-OptionalPhase $Mode

  $blockers = [Collections.Generic.List[string]]::new()
  if (-not $pen.present) { $blockers.Add('pen-digitizer-unavailable') }
  if (-not $ocr.runtimeAvailable -or $ocr.installedLanguageCount -eq 0) { $blockers.Add('windows-ocr-language-unavailable') }
  if (-not $oneNote.available) { $blockers.Add('onenote-executable-unavailable') }
  foreach ($groupName in $REQUIRED_ENVIRONMENT.Keys) {
    foreach ($name in $REQUIRED_ENVIRONMENT[$groupName]) {
      if (-not $environment[$groupName][$name].present) { $blockers.Add("environment-missing:$name") }
    }
  }
  if (-not $appwriteConfig.projectConfigured -or -not $appwriteConfig.endpointConfigured -or -not $appwriteConfig.resourceFilesPresent) {
    $blockers.Add('appwrite-project-not-configured')
  }
  if (-not $certificates.ready) { $blockers.Add('trusted-code-signing-certificate-unavailable') }
  foreach ($name in $EXPECTED_EVIDENCE.Keys) {
    if (-not $evidence[$name].present) { $blockers.Add("evidence-missing:$name") }
    elseif (-not $evidence[$name].valid) { $blockers.Add("evidence-invalid:${name}:$($evidence[$name].validation)") }
  }
  if ($Mode -eq 'Checklist' -and -not $checklist.valid) { $blockers.Add('personal-checklist-incomplete') }

  $reportStatus = if ($null -ne $fixture) { 'test-only' } elseif ($blockers.Count -eq 0) { 'ready' } else { 'blocked' }
  $report = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString('o')
    mode = $Mode
    contentPolicy = 'aggregate-and-presence-only'
    probeMode = if ($null -ne $fixture) { 'synthetic-policy-test' } else { 'live-read-only' }
    acceptanceEvidence = $null -eq $fixture
    repositoryBinding = $binding
    system = [ordered]@{ windows = $windows; penDigitizer = $pen; ocr = $ocr; oneNote = $oneNote }
    configuration = [ordered]@{ environment = $environment; appwrite = $appwriteConfig }
    codeSigning = $certificates
    expectedEvidence = $evidence
    checklist = $checklist
    optionalPhase = $phase
    summary = [ordered]@{ status = $reportStatus; blockers = @($blockers) }
  }
  $absoluteOutput = [IO.Path]::GetFullPath($OutputPath)
  $outputDirectory = [IO.Path]::GetDirectoryName($absoluteOutput)
  [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $absoluteOutput -Encoding UTF8
  [Console]::Out.WriteLine("[acceptance] $($report.summary.status); content-free report written")
  if ($blockers.Count -gt 0) { exit 2 }
  exit 0
} catch {
  $errorType = $_.Exception.GetType().Name
  $errorLine = $_.InvocationInfo.ScriptLineNumber
  [Console]::Error.WriteLine("[acceptance] ERROR: acceptance input or probe failed ($errorType at policy line $errorLine); no values were printed")
  exit 3
}
