<#
.SYNOPSIS
  Exports one OneNote notebook through the OneNote desktop COM API into a
  folder that Canvink's importer reads ("OneNote Desktop-Export (Ordner)").

.DESCRIPTION
  Strictly read-only towards OneNote: it calls only GetHierarchy and
  GetPageContent. It never updates, syncs, publishes, deletes or closes
  anything, and attaches to the OneNote instance that is already running.

  The export keeps OneNote's own page XML and moves binary data into files:

    manifest.json          notebook, sections (with section-group path), pages, assets
    pages\<n>.xml          GetPageContent(piAll, xs2013); one:Data replaced by canvink* attributes
    ink\<n>.json           ISF ink decoded with WPF: strokes, points, pressure, colour, width, highlighter
    assets\<sha256>.<ext>  images; EMF/WMF/TIFF printouts are rendered to PNG
    files\<sha256>.<ext>   inserted files (the PDF behind a printout, attachments) from OneNote's cache
    export.log             progress and per-page errors
    export-status.json     written last: { status: ok|failed, ... }

  OneNote's COM server only works in the signed-in user's interactive
  session. From SSH (session 0) it fails with CO_E_SERVER_EXEC_FAILURE or
  0x80042014. Use -ViaScheduledTask there: the script registers a temporary
  scheduled task that runs itself in the interactive session, waits for
  export-status.json and removes the task again.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File onenote-com-export.ps1 -NotebookName bm -OutputDirectory C:\Users\me\bm-export

.EXAMPLE
  # From an SSH session. The first COM call can take minutes when OneNote has
  # to start in the interactive session and load the notebook first.
  powershell -NoProfile -ExecutionPolicy Bypass -File onenote-com-export.ps1 -NotebookName bm -OutputDirectory C:\Users\me\bm-export -ViaScheduledTask
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $NotebookName,
  [Parameter(Mandatory = $true)] [string] $OutputDirectory,
  # Only export sections whose name (or group path) matches this wildcard.
  [string] $SectionFilter = '*',
  # Stop after this many pages (0 = all); for quick trial runs.
  [int] $MaxPages = 0,
  # Export only these OneNote page IDs (comma-separated); sections without one are left out.
  [string] $PageIds = '',
  # Resolution for rendering Windows metafile printouts to PNG.
  [int] $PrintoutDpi = 200,
  # Replace an earlier export in the same folder.
  [switch] $Force,
  [switch] $ViaScheduledTask,
  [int] $TimeoutMinutes = 120
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$ExportVersion = 1
$StatusFile = Join-Path $OutputDirectory 'export-status.json'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Invariant = [System.Globalization.CultureInfo]::InvariantCulture

function Write-Status([string] $Status, [string] $Message, [hashtable] $Extra = @{}) {
  $payload = [ordered]@{ status = $Status; message = $Message; finishedAt = (Get-Date).ToUniversalTime().ToString('o') }
  foreach ($key in $Extra.Keys) { $payload[$key] = $Extra[$key] }
  [System.IO.File]::WriteAllText($StatusFile, ($payload | ConvertTo-Json -Depth 4), $Utf8)
}

if ($ViaScheduledTask) {
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  if (Test-Path $StatusFile) { Remove-Item -LiteralPath $StatusFile -Force }
  $quoted = { param($value) '"' + ($value -replace '"', '\"') + '"' }
  $arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
    '-File', (& $quoted $PSCommandPath),
    '-NotebookName', (& $quoted $NotebookName),
    '-OutputDirectory', (& $quoted $OutputDirectory),
    '-SectionFilter', (& $quoted $SectionFilter),
    '-MaxPages', $MaxPages, '-PrintoutDpi', $PrintoutDpi
  )
  if ($PageIds) { $arguments += @('-PageIds', (& $quoted $PageIds)) }
  if ($Force) { $arguments += '-Force' }
  $taskName = 'CanvinkOneNoteExport-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($arguments -join ' ')
  $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes $TimeoutMinutes)
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
  try {
    Start-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $started = Get-Date
    while (-not (Test-Path $StatusFile)) {
      if ((Get-Date) -gt $deadline) { throw "The export did not finish within $TimeoutMinutes minutes." }
      Start-Sleep -Seconds 3
      $info = Get-ScheduledTaskInfo -TaskName $taskName
      $task = Get-ScheduledTask -TaskName $taskName
      # 0x41301 = running, 0x41303 = not yet run. Anything else while no status exists means it never started or crashed.
      if ($task.State -ne 'Running' -and ((Get-Date) - $started).TotalSeconds -gt 20 -and -not (Test-Path $StatusFile) `
          -and $info.LastTaskResult -ne 0x41301 -and $info.LastTaskResult -ne 0x41303) {
        throw ("The scheduled export task ended without a result (0x{0:x}). It may not have started because {1} is not signed in interactively, or it stopped early; see export.log." -f $info.LastTaskResult, $env:USERNAME)
      }
    }
    Get-Content -LiteralPath $StatusFile -Raw
  } finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  return
}

Add-Type -AssemblyName PresentationCore, WindowsBase, System.Xaml, System.Drawing

# --- output folder ----------------------------------------------------------

if (Test-Path $OutputDirectory) {
  $existing = @(Get-ChildItem -LiteralPath $OutputDirectory -Force | Where-Object { $_.Name -ne 'export-status.json' })
  if ($existing.Count -gt 0) {
    if (-not $Force) { throw "$OutputDirectory is not empty. Use -Force to replace an earlier export." }
    # Remove only what this exporter writes.
    foreach ($name in 'pages', 'ink', 'assets', 'files', 'manifest.json', 'export.log') {
      $path = Join-Path $OutputDirectory $name
      if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
  }
}
foreach ($name in '', 'pages', 'ink', 'assets', 'files') {
  New-Item -ItemType Directory -Force -Path (Join-Path $OutputDirectory $name) | Out-Null
}
if (Test-Path $StatusFile) { Remove-Item -LiteralPath $StatusFile -Force }
$LogFile = Join-Path $OutputDirectory 'export.log'

function Log([string] $Message) {
  $line = (Get-Date).ToString('HH:mm:ss') + ' ' + $Message
  [System.IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, $Utf8)
  Write-Verbose $line
}

# --- helpers ----------------------------------------------------------------

$Sha = [System.Security.Cryptography.SHA256]::Create()
function Get-Sha256Hex([byte[]] $Bytes) {
  ($Sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Format-Number([double] $Value) { $Value.ToString('0.###', $Invariant) }

function ConvertTo-JsonString([string] $Value) {
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  foreach ($character in $Value.ToCharArray()) {
    switch ($character) {
      '"' { [void]$builder.Append('\"') }
      '\' { [void]$builder.Append('\\') }
      default {
        if ([int]$character -lt 0x20) { [void]$builder.AppendFormat('\u{0:x4}', [int]$character) }
        else { [void]$builder.Append($character) }
      }
    }
  }
  [void]$builder.Append('"')
  $builder.ToString()
}

$MediaTypes = @{
  '.pdf' = 'application/pdf'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.gif' = 'image/gif';
  '.bmp' = 'image/bmp'; '.webp' = 'image/webp'; '.docx' = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  '.doc' = 'application/msword'; '.xlsx' = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  '.xls' = 'application/vnd.ms-excel'; '.pptx' = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  '.ppt' = 'application/vnd.ms-powerpoint'; '.txt' = 'text/plain'; '.csv' = 'text/csv'; '.zip' = 'application/zip';
  '.mp3' = 'audio/mpeg'; '.m4a' = 'audio/mp4'; '.wav' = 'audio/wav'; '.wma' = 'audio/x-ms-wma'; '.mp4' = 'video/mp4';
  '.ggb' = 'application/vnd.geogebra.file'; '.odt' = 'application/vnd.oasis.opendocument.text'
}

$Assets = [ordered]@{}
function Save-Asset([byte[]] $Bytes, [string] $Folder, [string] $Extension, [string] $MediaType, [hashtable] $Extra) {
  $hash = Get-Sha256Hex $Bytes
  $relative = "$Folder/$hash$Extension"
  if (-not $Assets.Contains($relative)) {
    [System.IO.File]::WriteAllBytes((Join-Path $OutputDirectory ($relative -replace '/', '\')), $Bytes)
    $entry = [ordered]@{ path = $relative; mediaType = $MediaType; bytes = $Bytes.Length; sha256 = $hash }
    foreach ($key in $Extra.Keys) { if ($null -ne $Extra[$key]) { $entry[$key] = $Extra[$key] } }
    $Assets[$relative] = $entry
  }
  $relative
}

function Get-ImageSize([byte[]] $Bytes) {
  $stream = New-Object System.IO.MemoryStream(, $Bytes)
  try {
    $image = [System.Drawing.Image]::FromStream($stream, $false, $false)
    try { @{ width = $image.Width; height = $image.Height } } finally { $image.Dispose() }
  } catch { @{ width = $null; height = $null } } finally { $stream.Dispose() }
}

# Renders a metafile (or any GDI+ image) to PNG. The pixel size follows the
# object's size on the page in points at -PrintoutDpi, so printouts stay sharp.
function Convert-ToPng([byte[]] $Bytes, [double] $WidthPt, [double] $HeightPt) {
  $stream = New-Object System.IO.MemoryStream(, $Bytes)
  $image = [System.Drawing.Image]::FromStream($stream)
  try {
    if ($WidthPt -gt 0 -and $HeightPt -gt 0) {
      $width = [int][Math]::Ceiling($WidthPt / 72 * $PrintoutDpi)
      $height = [int][Math]::Ceiling($HeightPt / 72 * $PrintoutDpi)
    } else {
      $width = [int][Math]::Ceiling($image.Width / [Math]::Max(1, $image.HorizontalResolution) * $PrintoutDpi)
      $height = [int][Math]::Ceiling($image.Height / [Math]::Max(1, $image.VerticalResolution) * $PrintoutDpi)
    }
    # Stay under Canvink's 40 megapixel limit.
    $scale = [Math]::Min(1, [Math]::Sqrt(36000000 / [Math]::Max(1, $width * $height)))
    $width = [Math]::Max(1, [int]($width * $scale)); $height = [Math]::Max(1, [int]($height * $scale))
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::White)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($image, 0, 0, $width, $height)
      } finally { $graphics.Dispose() }
      $output = New-Object System.IO.MemoryStream
      $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
      @{ bytes = $output.ToArray(); width = $width; height = $height }
    } finally { $bitmap.Dispose() }
  } finally { $image.Dispose(); $stream.Dispose() }
}

# ISF ink is decoded by WPF. The per-point JSON is written in C#: PowerShell's
# per-call overhead would make pages with tens of thousands of points slow.
Add-Type -ReferencedAssemblies @(
  [System.Windows.Ink.StrokeCollection].Assembly.Location,
  [System.Windows.Point].Assembly.Location,
  [System.Xaml.XamlReader].Assembly.Location
) -TypeDefinition @'
using System.Globalization;
using System.IO;
using System.Text;
using System.Windows.Ink;
using System.Windows.Input;

public sealed class CanvinkInkJson {
  public string Json;
  public int Strokes;

  static string F(double value) { return value.ToString("0.###", CultureInfo.InvariantCulture); }

  public static CanvinkInkJson FromIsf(byte[] bytes) {
    StrokeCollection strokes;
    using (var stream = new MemoryStream(bytes)) { strokes = new StrokeCollection(stream); }
    var bounds = strokes.GetBounds();
    var json = new StringBuilder();
    json.Append("{\"bounds\":[");
    if (bounds.IsEmpty) json.Append("0,0,0,0");
    else json.Append(F(bounds.X)).Append(',').Append(F(bounds.Y)).Append(',').Append(F(bounds.Width)).Append(',').Append(F(bounds.Height));
    json.Append("],\"strokes\":[");
    bool firstStroke = true;
    foreach (Stroke stroke in strokes) {
      var attributes = stroke.DrawingAttributes;
      var color = attributes.Color;
      if (!firstStroke) json.Append(',');
      firstStroke = false;
      json.Append("{\"c\":\"#").Append(color.R.ToString("x2")).Append(color.G.ToString("x2")).Append(color.B.ToString("x2"));
      json.Append("\",\"a\":").Append(color.A);
      json.Append(",\"w\":").Append(F(attributes.Width)).Append(",\"h\":").Append(F(attributes.Height));
      json.Append(",\"hl\":").Append(attributes.IsHighlighter ? "true" : "false");
      json.Append(",\"ip\":").Append(attributes.IgnorePressure ? "true" : "false");
      json.Append(",\"p\":[");
      bool firstPoint = true;
      foreach (StylusPoint point in stroke.StylusPoints) {
        if (!firstPoint) json.Append(',');
        firstPoint = false;
        json.Append(F(point.X)).Append(',').Append(F(point.Y)).Append(',').Append(F(point.PressureFactor));
      }
      json.Append("]}");
    }
    json.Append("]}");
    return new CanvinkInkJson { Json = json.ToString(), Strokes = strokes.Count };
  }
}
'@

function Convert-InkToJson([byte[]] $Bytes) {
  $decoded = [CanvinkInkJson]::FromIsf($Bytes)
  @{ json = $decoded.Json; strokes = $decoded.Strokes }
}

# --- export -----------------------------------------------------------------

$OneNoteNamespace = 'http://schemas.microsoft.com/office/onenote/2013/onenote'
$app = $null
$totals = [ordered]@{ sections = 0; pages = 0; pageErrors = 0; images = 0; printouts = 0; files = 0; inkObjects = 0; inkStrokes = 0; notDownloaded = 0 }
$errors = New-Object System.Collections.Generic.List[string]
try {
  Log "Canvink OneNote export v$ExportVersion for notebook '$NotebookName'"
  $app = New-Object -ComObject OneNote.Application
  [string] $hierarchyXml = ''
  # hsPages = 4, xs2013 = 2
  $app.GetHierarchy('', 4, [ref] $hierarchyXml, 2)
  $hierarchy = New-Object System.Xml.XmlDocument
  $hierarchy.LoadXml($hierarchyXml)
  $names = New-Object System.Xml.XmlNamespaceManager($hierarchy.NameTable)
  $names.AddNamespace('one', $OneNoteNamespace)
  $notebook = @($hierarchy.SelectNodes('/one:Notebooks/one:Notebook', $names) |
    Where-Object { $_.GetAttribute('name') -eq $NotebookName -or $_.GetAttribute('nickname') -eq $NotebookName }) | Select-Object -First 1
  if ($null -eq $notebook) {
    $available = @($hierarchy.SelectNodes('/one:Notebooks/one:Notebook', $names) | ForEach-Object { $_.GetAttribute('name') }) -join ', '
    throw "OneNote has no open notebook named '$NotebookName'. Open notebooks: $available"
  }

  $sections = New-Object System.Collections.Generic.List[object]
  function Add-Sections($Node, [string[]] $GroupPath) {
    foreach ($child in $Node.ChildNodes) {
      if ($child.NamespaceURI -ne $OneNoteNamespace) { continue }
      if ($child.LocalName -eq 'SectionGroup') {
        if ($child.GetAttribute('isRecycleBin') -eq 'true') { continue }
        Add-Sections $child ($GroupPath + @($child.GetAttribute('name')))
      } elseif ($child.LocalName -eq 'Section') {
        if ($child.GetAttribute('isInRecycleBin') -eq 'true') { continue }
        $sections.Add(@{ node = $child; groupPath = $GroupPath })
      }
    }
  }
  Add-Sections $notebook @()

  $wantedPages = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($id in ($PageIds -split ',')) { if ($id.Trim()) { [void]$wantedPages.Add($id.Trim()) } }
  $manifestSections = New-Object System.Collections.Generic.List[object]
  $pageNumber = 0
  $stop = $false
  foreach ($entry in $sections) {
    if ($stop) { break }
    $section = $entry.node
    $sectionName = $section.GetAttribute('name')
    $fullName = (@($entry.groupPath) + @($sectionName)) -join '/'
    if ($fullName -notlike $SectionFilter -and $sectionName -notlike $SectionFilter) { continue }
    if ($wantedPages.Count -gt 0 -and -not @($section.ChildNodes | Where-Object { $wantedPages.Contains($_.GetAttribute('ID')) }).Count) { continue }
    $totals.sections++
    $sectionPages = New-Object System.Collections.Generic.List[object]
    $sectionColor = $section.GetAttribute('color')
    $manifestSection = [ordered]@{
      id = $section.GetAttribute('ID'); name = $sectionName; groupPath = @($entry.groupPath)
      color = $(if ($sectionColor -and $sectionColor -ne 'none') { $sectionColor } else { $null })
      encrypted = ($section.GetAttribute('encrypted') -eq 'true'); locked = ($section.GetAttribute('locked') -eq 'true')
      pages = $sectionPages
    }
    Log "Section '$fullName'"
    foreach ($page in $section.ChildNodes) {
      if ($page.NamespaceURI -ne $OneNoteNamespace -or $page.LocalName -ne 'Page') { continue }
      if ($page.GetAttribute('isInRecycleBin') -eq 'true') { continue }
      if ($wantedPages.Count -gt 0 -and -not $wantedPages.Contains($page.GetAttribute('ID'))) { continue }
      if ($MaxPages -gt 0 -and $pageNumber -ge $MaxPages) { $stop = $true; break }
      $pageNumber++
      $totals.pages++
      $stem = $pageNumber.ToString('0000')
      $level = 1
      [void][int]::TryParse($page.GetAttribute('pageLevel'), [ref] $level)
      $manifestPage = [ordered]@{
        id = $page.GetAttribute('ID'); name = $page.GetAttribute('name'); level = $level
        created = $page.GetAttribute('dateTime'); modified = $page.GetAttribute('lastModifiedTime')
      }
      try {
        [string] $pageXml = ''
        # piAll = 7 (binary data, selection, file types), xs2013 = 2
        $app.GetPageContent($manifestPage.id, [ref] $pageXml, 7, 2)
        $document = New-Object System.Xml.XmlDocument
        $document.PreserveWhitespace = $true
        $document.LoadXml($pageXml)
        $pageNames = New-Object System.Xml.XmlNamespaceManager($document.NameTable)
        $pageNames.AddNamespace('one', $OneNoteNamespace)
        $inkEntries = New-Object System.Collections.Generic.List[string]
        $inkIndex = 0

        foreach ($data in @($document.SelectNodes('//one:Data', $pageNames))) {
          $owner = $data.ParentNode
          $kind = $owner.LocalName
          try {
            $bytes = [Convert]::FromBase64String($data.InnerText)
            if ($bytes.Length -eq 0) {
              # OneNote returns no bytes for pictures it has not downloaded from the server yet.
              $owner.SetAttribute('canvinkError', 'OneNote has not downloaded this object to this computer yet')
              $totals.notDownloaded++
            } elseif ($kind -eq 'Image') {
              $format = $owner.GetAttribute('format').ToLowerInvariant()
              $size = $owner.SelectSingleNode('one:Size', $pageNames)
              $widthPt = 0.0; $heightPt = 0.0
              if ($null -ne $size) {
                [void][double]::TryParse($size.GetAttribute('width'), [System.Globalization.NumberStyles]::Float, $Invariant, [ref] $widthPt)
                [void][double]::TryParse($size.GetAttribute('height'), [System.Globalization.NumberStyles]::Float, $Invariant, [ref] $heightPt)
              }
              $extra = @{}
              if ($format -in @('png', 'jpg', 'jpeg', 'gif')) {
                $extension = $(if ($format -eq 'jpeg') { '.jpg' } else { ".$format" })
                $pixelSize = Get-ImageSize $bytes
                $extra = @{ width = $pixelSize.width; height = $pixelSize.height }
              } else {
                $rendered = Convert-ToPng $bytes $widthPt $heightPt
                $bytes = $rendered.bytes
                $extension = '.png'
                $extra = @{ width = $rendered.width; height = $rendered.height; sourceFormat = $format }
              }
              $relative = Save-Asset $bytes 'assets' $extension $MediaTypes[$extension] $extra
              $owner.SetAttribute('canvinkAsset', $relative)
              if ($extra.width) { $owner.SetAttribute('canvinkPixelWidth', [string]$extra.width); $owner.SetAttribute('canvinkPixelHeight', [string]$extra.height) }
              if ($owner.GetAttribute('isPrintOut') -eq 'true') { $totals.printouts++ } else { $totals.images++ }
            } elseif ($kind -like 'Ink*') {
              $decoded = Convert-InkToJson $bytes
              $key = 'i' + $inkIndex
              $inkIndex++
              $inkEntries.Add((ConvertTo-JsonString $key) + ':' + $decoded.json)
              $owner.SetAttribute('canvinkInk', $key)
              $totals.inkObjects++
              $totals.inkStrokes += $decoded.strokes
            } else {
              $owner.SetAttribute('canvinkError', "binary data of $kind is not exported")
            }
          } catch {
            $owner.SetAttribute('canvinkError', $_.Exception.Message)
            Log "  page $stem ${kind}: $($_.Exception.Message)"
          }
          [void]$owner.RemoveChild($data)
        }

        foreach ($file in @($document.SelectNodes('//one:InsertedFile | //one:MediaFile', $pageNames))) {
          $cache = $file.GetAttribute('pathCache')
          $name = $file.GetAttribute('preferredName')
          if (-not $name) { $name = [System.IO.Path]::GetFileName($file.GetAttribute('pathSource')) }
          if ($cache -and (Test-Path -LiteralPath $cache) -and (Get-Item -LiteralPath $cache).Length -eq 0) {
            $file.SetAttribute('canvinkError', 'OneNote has not downloaded this file to this computer yet')
            $totals.notDownloaded++
          } elseif ($cache -and (Test-Path -LiteralPath $cache)) {
            $extension = [System.IO.Path]::GetExtension($name).ToLowerInvariant()
            $mediaType = $MediaTypes[$extension]
            if (-not $mediaType) { $mediaType = 'application/octet-stream' }
            $relative = Save-Asset ([System.IO.File]::ReadAllBytes($cache)) 'files' $extension $mediaType @{ originalName = $name }
            $file.SetAttribute('canvinkFile', $relative)
            $totals.files++
          } else {
            $file.SetAttribute('canvinkError', 'the file is not in the local OneNote cache')
          }
        }

        $settings = New-Object System.Xml.XmlWriterSettings
        $settings.Encoding = $Utf8
        $writer = [System.Xml.XmlWriter]::Create((Join-Path $OutputDirectory "pages\$stem.xml"), $settings)
        try { $document.Save($writer) } finally { $writer.Dispose() }
        $manifestPage.file = "pages/$stem.xml"
        if ($inkEntries.Count -gt 0) {
          [System.IO.File]::WriteAllText((Join-Path $OutputDirectory "ink\$stem.json"), '{"objects":{' + ($inkEntries -join ',') + '}}', $Utf8)
          $manifestPage.ink = "ink/$stem.json"
        }
      } catch {
        $totals.pageErrors++
        $manifestPage.error = $_.Exception.Message
        $errors.Add("page $stem ($($manifestPage.id)): $($_.Exception.Message)")
        Log "  page $stem failed: $($_.Exception.Message)"
      }
      $sectionPages.Add($manifestPage)
      if ($pageNumber % 10 -eq 0) { Log "  $pageNumber pages" }
    }
    $manifestSections.Add($manifestSection)
  }

  $notebookInfo = [ordered]@{}
  $notebookInfo['id'] = $notebook.GetAttribute('ID')
  $notebookInfo['name'] = $notebook.GetAttribute('name')
  $notebookInfo['nickname'] = $notebook.GetAttribute('nickname')
  $notebookColor = $notebook.GetAttribute('color')
  if ($notebookColor -and $notebookColor -ne 'none') { $notebookInfo['color'] = $notebookColor }
  $manifest = [ordered]@{
    format = 'canvink-onenote-desktop-export'
    version = $ExportVersion
    exportedAt = (Get-Date).ToUniversalTime().ToString('o')
    generator = "onenote-com-export.ps1 v$ExportVersion"
    notebook = $notebookInfo
    sections = $manifestSections.ToArray()
    assets = @($Assets.Values)
    errors = $errors.ToArray()
    totals = $totals
  }
  [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8), $Utf8)
  Log ("Done: " + (($totals.Keys | ForEach-Object { "$_=$($totals[$_])" }) -join ' '))
  Write-Status 'ok' 'The notebook was exported.' @{ totals = $totals }
} catch {
  Log "FAILED: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber): $($_.InvocationInfo.Line.Trim())"
  Write-Status 'failed' $_.Exception.Message @{ totals = $totals }
  throw
} finally {
  # Releases only this script's reference; OneNote itself keeps running.
  if ($null -ne $app) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}
