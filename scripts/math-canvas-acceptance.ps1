[CmdletBinding()]
param(
  [string] $EvidenceRoot = '',
  [string] $OutputPath = 'test-results/math-canvas-acceptance.json'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Set-Variable -Name EVIDENCE_MAX_BYTES -Value 1048576 -Option Constant
Set-Variable -Name EVIDENCE_MAX_AGE_DAYS -Value 7 -Option Constant
Set-Variable -Name EXPECTED_EVIDENCE -Value ([ordered]@{
  recognitionCorpus = [ordered]@{
    file = 'recognition-corpus.json'
    kind = 'math-recognition-corpus'
    producer = 'canvink-math-recognition-benchmark-v1'
  }
  gpuLatency = [ordered]@{
    file = 'gpu-latency.json'
    kind = 'math-gpu-latency'
    producer = 'canvink-math-gpu-benchmark-v1'
  }
  privacy = [ordered]@{
    file = 'privacy.json'
    kind = 'math-privacy'
    producer = 'canvink-math-privacy-verifier-v1'
  }
  personalWorkflows = [ordered]@{
    file = 'personal-workflows.json'
    kind = 'math-personal-workflows'
    producer = 'canvink-math-personal-workflow-drill-v1'
  }
}) -Option Constant
Set-Variable -Name REQUIRED_GPU_CLASSES -Value @('RTX-2070', 'RTX-5060') -Option Constant
Set-Variable -Name FORBIDDEN_CONTENT_KEYS -Value @(
  'formula', 'latex', 'rawLatex', 'strokes', 'rawStrokes', 'note', 'notes', 'title',
  'pageTitle', 'notebookTitle', 'content', 'text', 'token', 'apiKey', 'secret',
  'endpoint', 'url', 'accountId', 'writerId', 'writerIds', 'fileName', 'path',
  'providerConfig'
) -Option Constant

function Assert-ExactProperties {
  param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string[]]$Names)
  if ($null -eq $Value -or $Value -isnot [psobject]) { throw 'shape' }
  $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
  $expected = @($Names | Sort-Object)
  if ($actual.Count -ne $expected.Count -or @(Compare-Object $actual $expected).Count -ne 0) {
    throw 'shape'
  }
}

function Test-NumericValue {
  param([AllowNull()]$Value)
  return $Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or
    $Value -is [uint16] -or $Value -is [int32] -or $Value -is [uint32] -or
    $Value -is [int64] -or $Value -is [uint64] -or $Value -is [single] -or
    $Value -is [double] -or $Value -is [decimal]
}

function Assert-Integer {
  param([AllowNull()]$Value)
  if (-not (Test-NumericValue $Value) -or [double]$Value -ne [math]::Truncate([double]$Value)) {
    throw 'shape'
  }
}

function Assert-Boolean {
  param([AllowNull()]$Value)
  if ($Value -isnot [bool]) { throw 'shape' }
}

function Assert-NoContentFields {
  param([AllowNull()]$Value)
  if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) { return }
  if ($Value -is [Collections.IEnumerable] -and $Value -isnot [pscustomobject]) {
    foreach ($entry in $Value) { Assert-NoContentFields $entry }
    return
  }
  foreach ($property in $Value.PSObject.Properties) {
    if ($FORBIDDEN_CONTENT_KEYS -ccontains $property.Name) { throw 'content-bearing' }
    Assert-NoContentFields $property.Value
  }
}

function Assert-CommonEnvelope {
  param(
    [Parameter(Mandatory)]$Evidence,
    [Parameter(Mandatory)][string]$Kind,
    [Parameter(Mandatory)][string]$Producer,
    [Parameter(Mandatory)][string]$RepositoryCommit,
    [Parameter(Mandatory)][string]$PackageVersion
  )
  Assert-NoContentFields $Evidence
  Assert-ExactProperties $Evidence @(
    'schemaVersion', 'kind', 'contentFree', 'repositoryCommit', 'packageVersion',
    'recordedAt', 'status', 'producer', 'results'
  )
  Assert-Integer $Evidence.schemaVersion
  if ([int]$Evidence.schemaVersion -ne 1) { throw 'schema' }
  if ([string]$Evidence.kind -cne $Kind -or [string]$Evidence.producer -cne $Producer) { throw 'kind' }
  Assert-Boolean $Evidence.contentFree
  if (-not [bool]$Evidence.contentFree) { throw 'content-bearing' }
  if ([string]$Evidence.status -cne 'passed') { throw 'status' }
  if ([string]$Evidence.repositoryCommit -notmatch '^[0-9a-f]{40}$' -or
      [string]$Evidence.repositoryCommit -cne $RepositoryCommit -or
      [string]$Evidence.packageVersion -cne $PackageVersion) {
    throw 'binding'
  }
  $recordedAtText = [string]$Evidence.recordedAt
  if ($recordedAtText -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3,7})?Z$') { throw 'timestamp' }
  try { $recordedAt = [DateTimeOffset]::Parse($recordedAtText, [Globalization.CultureInfo]::InvariantCulture) } catch { throw 'timestamp' }
  $now = [DateTimeOffset]::UtcNow
  if ($recordedAt -lt $now.AddDays(-$EVIDENCE_MAX_AGE_DAYS) -or $recordedAt -gt $now.AddMinutes(5)) { throw 'stale' }
}

function Assert-RecognitionCorpus {
  param([Parameter(Mandatory)]$Results)
  Assert-ExactProperties $Results @(
    'corpusSha256', 'licenseManifestSha256', 'sampleCount', 'writerCount', 'basicCorrect',
    'basicTotal', 'totalCorrect', 'totalCount', 'basicAccuracyPercent',
    'overallAccuracyPercent', 'provenanceReviewed', 'selfCreatedOrExplicitlyLicensed',
    'restrictedResearchDatasetUsed'
  )
  if ([string]$Results.corpusSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$Results.licenseManifestSha256 -notmatch '^[0-9a-f]{64}$') { throw 'provenance' }
  foreach ($name in @('sampleCount', 'writerCount', 'basicCorrect', 'basicTotal', 'totalCorrect', 'totalCount')) {
    Assert-Integer $Results.$name
  }
  foreach ($name in @('provenanceReviewed', 'selfCreatedOrExplicitlyLicensed', 'restrictedResearchDatasetUsed')) {
    Assert-Boolean $Results.$name
  }
  if (-not $Results.provenanceReviewed -or -not $Results.selfCreatedOrExplicitlyLicensed -or
      $Results.restrictedResearchDatasetUsed) { throw 'provenance' }
  if ([int]$Results.sampleCount -lt 300 -or [int]$Results.writerCount -lt 5 -or
      [int]$Results.basicTotal -le 0 -or [int]$Results.totalCount -le 0 -or
      [int]$Results.totalCount -ne [int]$Results.sampleCount -or
      [int]$Results.basicCorrect -lt 0 -or [int]$Results.totalCorrect -lt 0 -or
      [int]$Results.basicCorrect -gt [int]$Results.basicTotal -or
      [int]$Results.totalCorrect -gt [int]$Results.totalCount -or
      [int]$Results.basicTotal -gt [int]$Results.totalCount -or
      [int]$Results.basicCorrect -gt [int]$Results.totalCorrect) { throw 'threshold' }
  if (-not (Test-NumericValue $Results.basicAccuracyPercent) -or
      -not (Test-NumericValue $Results.overallAccuracyPercent)) { throw 'shape' }
  $calculatedBasic = 100.0 * [double]$Results.basicCorrect / [double]$Results.basicTotal
  $calculatedOverall = 100.0 * [double]$Results.totalCorrect / [double]$Results.totalCount
  if ([math]::Abs([double]$Results.basicAccuracyPercent - $calculatedBasic) -gt 0.01 -or
      [math]::Abs([double]$Results.overallAccuracyPercent - $calculatedOverall) -gt 0.01 -or
      $calculatedBasic -lt 90.0 -or $calculatedOverall -lt 80.0) { throw 'threshold' }
}

function Assert-GpuLatency {
  param([Parameter(Mandatory)]$Results)
  Assert-ExactProperties $Results @(
    'modelArtifactSha256', 'apiVersion', 'measurements', 'privateServiceOnly', 'rawContentIncluded'
  )
  if ([string]$Results.modelArtifactSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$Results.apiVersion -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'shape' }
  Assert-Boolean $Results.privateServiceOnly
  Assert-Boolean $Results.rawContentIncluded
  if (-not $Results.privateServiceOnly -or $Results.rawContentIncluded) { throw 'privacy' }
  $measurements = @($Results.measurements)
  if ($measurements.Count -ne 2) { throw 'threshold' }
  $gpuClasses = @{}
  foreach ($measurement in $measurements) {
    Assert-ExactProperties $measurement @('gpuClass', 'sampleCount', 'medianMs', 'p95Ms')
    if ([string]$measurement.gpuClass -notmatch '^[A-Za-z0-9 ._-]{1,64}$' -or $gpuClasses.ContainsKey([string]$measurement.gpuClass)) {
      throw 'shape'
    }
    $gpuClasses[[string]$measurement.gpuClass] = $true
    Assert-Integer $measurement.sampleCount
    if (-not (Test-NumericValue $measurement.medianMs) -or -not (Test-NumericValue $measurement.p95Ms)) { throw 'shape' }
    if ([int]$measurement.sampleCount -le 0 -or [double]$measurement.medianMs -lt 0 -or
        [double]$measurement.p95Ms -lt [double]$measurement.medianMs -or
        [double]$measurement.medianMs -gt 1500 -or [double]$measurement.p95Ms -gt 3000) { throw 'threshold' }
  }
  if ($gpuClasses.Count -ne $REQUIRED_GPU_CLASSES.Count -or
      @($REQUIRED_GPU_CLASSES | Where-Object { -not $gpuClasses.ContainsKey($_) }).Count -ne 0) {
    throw 'threshold'
  }
}

function Assert-Privacy {
  param([Parameter(Mandatory)]$Results)
  $counterNames = @(
    'normalStrokeRequestCount', 'explicitMathBlockRequestCount', 'wholePageRequestCount',
    'adjacentContentRequestCount', 'unexpectedRequestFieldCount', 'keyLeakCount',
    'providerConfigLeakCount', 'workspaceSecretLeakCount', 'exportSecretLeakCount',
    'logContentLeakCount', 'telemetryContentLeakCount'
  )
  $booleanNames = @('selectedBlockOnly', 'localRawMathPersistenceVerified', 'networkCaptureReviewed')
  Assert-ExactProperties $Results @($counterNames + $booleanNames)
  foreach ($name in $counterNames) {
    Assert-Integer $Results.$name
    if ([int]$Results.$name -lt 0) { throw 'shape' }
  }
  foreach ($name in $booleanNames) { Assert-Boolean $Results.$name }
  if ([int]$Results.explicitMathBlockRequestCount -le 0 -or
      [int]$Results.normalStrokeRequestCount -ne 0 -or
      [int]$Results.wholePageRequestCount -ne 0 -or
      [int]$Results.adjacentContentRequestCount -ne 0 -or
      [int]$Results.unexpectedRequestFieldCount -ne 0 -or
      [int]$Results.keyLeakCount -ne 0 -or
      [int]$Results.providerConfigLeakCount -ne 0 -or
      [int]$Results.workspaceSecretLeakCount -ne 0 -or
      [int]$Results.exportSecretLeakCount -ne 0 -or
      [int]$Results.logContentLeakCount -ne 0 -or
      [int]$Results.telemetryContentLeakCount -ne 0 -or
      -not $Results.selectedBlockOnly -or -not $Results.localRawMathPersistenceVerified -or
      -not $Results.networkCaptureReviewed) { throw 'privacy' }
}

function Assert-PersonalWorkflows {
  param([Parameter(Mandatory)]$Results)
  $booleanNames = @(
    'mathematics', 'physics', 'pdfWorksheet', 'budget', 'offline', 'exportRoundTrip',
    'providerFailurePendingState', 'completedWithoutDataLoss'
  )
  Assert-ExactProperties $Results @(@('workflowsTested') + $booleanNames)
  Assert-Integer $Results.workflowsTested
  if ([int]$Results.workflowsTested -lt 4) { throw 'workflow' }
  foreach ($name in $booleanNames) {
    Assert-Boolean $Results.$name
    if (-not $Results.$name) { throw 'workflow' }
  }
}

function Test-EvidenceFile {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)]$Definition,
    [Parameter(Mandatory)][string]$RepositoryCommit,
    [Parameter(Mandatory)][string]$PackageVersion,
    [Parameter(Mandatory)][string]$Name
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [ordered]@{ present = $false; valid = $false; validation = 'missing' } }
  try {
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -gt $EVIDENCE_MAX_BYTES) { throw 'size' }
    try { $evidence = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'malformed' }
    Assert-CommonEnvelope $evidence $Definition.kind $Definition.producer $RepositoryCommit $PackageVersion
    switch ($Name) {
      'recognitionCorpus' { Assert-RecognitionCorpus $evidence.results }
      'gpuLatency' { Assert-GpuLatency $evidence.results }
      'privacy' { Assert-Privacy $evidence.results }
      'personalWorkflows' { Assert-PersonalWorkflows $evidence.results }
      default { throw 'policy' }
    }
    return [ordered]@{ present = $true; valid = $true; validation = 'passed' }
  } catch {
    $reason = [string]$_.Exception.Message
    if ($reason -notin @('size', 'malformed', 'content-bearing', 'shape', 'schema', 'kind', 'status', 'binding', 'timestamp', 'stale', 'threshold', 'provenance', 'privacy', 'workflow')) {
      $reason = 'malformed'
    }
    return [ordered]@{ present = $true; valid = $false; validation = $reason }
  }
}

try {
  $repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  $testMode = [Environment]::GetEnvironmentVariable('CANVINK_MATH_ACCEPTANCE_POLICY_TEST_MODE') -ceq '1'
  if (-not [string]::IsNullOrWhiteSpace($EvidenceRoot) -and -not $testMode) {
    throw 'EvidenceRoot overrides are restricted to policy tests.'
  }
  $resolvedEvidenceRoot = if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) {
    Join-Path $repositoryRoot 'test-results\math-canvas-acceptance'
  } else {
    [IO.Path]::GetFullPath($EvidenceRoot)
  }
  $resolvedOutputPath = if ([IO.Path]::IsPathRooted($OutputPath)) {
    [IO.Path]::GetFullPath($OutputPath)
  } else {
    [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputPath))
  }
  $repositoryCommit = ''
  if ($testMode) {
    $repositoryCommit = [Environment]::GetEnvironmentVariable('CANVINK_MATH_ACCEPTANCE_TEST_REPOSITORY_COMMIT')
    $packageVersion = [Environment]::GetEnvironmentVariable('CANVINK_MATH_ACCEPTANCE_TEST_PACKAGE_VERSION')
    $worktreeState = [Environment]::GetEnvironmentVariable('CANVINK_MATH_ACCEPTANCE_TEST_WORKTREE_STATE')
    if ($worktreeState -cne 'clean' -and $worktreeState -cne 'dirty') { throw 'Invalid simulated worktree state.' }
    $worktreeDirty = $worktreeState -ceq 'dirty'
  } else {
    $repositoryCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $repositoryCommit -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve repository commit.' }
    $packageVersion = [string](Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json).version
    $worktreeStatus = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect repository worktree.' }
    $worktreeDirty = $worktreeStatus.Count -ne 0
  }
  if ($repositoryCommit -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve repository commit.' }
  if ($worktreeDirty) { throw 'Math Canvas acceptance requires a clean worktree at the exact evidence commit.' }
  if ($packageVersion -notmatch '^0\.2\.0(?:-beta(?:\.[0-9A-Za-z-]+)*)?$') {
    throw 'Math Canvas acceptance requires package version 0.2.0 or a 0.2.0-beta prerelease.'
  }

  $evidenceReport = [ordered]@{}
  $blockers = @()
  foreach ($name in $EXPECTED_EVIDENCE.Keys) {
    $definition = $EXPECTED_EVIDENCE[$name]
    $validation = Test-EvidenceFile (Join-Path $resolvedEvidenceRoot $definition.file) $definition $repositoryCommit $packageVersion $name
    $evidenceReport[$name] = [ordered]@{
      expectedPath = "test-results/math-canvas-acceptance/$($definition.file)"
      present = $validation.present
      valid = $validation.valid
      validation = $validation.validation
    }
    if (-not $validation.valid) { $blockers += "$name`:$($validation.validation)" }
  }
  $status = if ($blockers.Count -eq 0) { 'passed' } else { 'blocked' }
  $report = [ordered]@{
    schemaVersion = 1
    kind = 'math-canvas-acceptance-report'
    contentFree = $true
    repositoryCommit = $repositoryCommit
    packageVersion = $packageVersion
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    status = $status
    producer = 'canvink-math-canvas-acceptance-v1'
    evidence = $evidenceReport
    blockers = $blockers
  }
  $outputDirectory = Split-Path -Parent $resolvedOutputPath
  if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) { New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null }
  $reportJson = $report | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($resolvedOutputPath, $reportJson, [Text.UTF8Encoding]::new($false))
  Write-Output "Math Canvas acceptance: $status"
  foreach ($blocker in $blockers) { Write-Output "BLOCKED $blocker" }
  if ($status -eq 'passed') { exit 0 }
  exit 2
} catch {
  [Console]::Error.WriteLine([string]$_.Exception.Message)
  exit 3
}
