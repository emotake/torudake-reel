[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Database = "torudake-reel-db",
  [Parameter(Mandatory = $true)][string]$OffsiteDestination,
  [string]$BackupRoot = "D:\TorudakeBackups\d1",
  [string]$AgeRecipient = $env:TORUDAKE_BACKUP_AGE_RECIPIENT,
  [string]$Config = "wrangler.d1.jsonc"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$resolvedBackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
if (-not $resolvedBackupRoot.StartsWith("D:\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "BackupRoot must be an explicit directory on drive D:."
}
if ([string]::IsNullOrWhiteSpace($AgeRecipient)) {
  throw "TORUDAKE_BACKUP_AGE_RECIPIENT is required; no encryption key may be committed."
}
if (-not (Get-Command age -ErrorAction SilentlyContinue)) {
  throw "age is required to encrypt the backup before offsite transfer."
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$workingDirectory = Join-Path $resolvedBackupRoot $stamp
$sqlPath = Join-Path $workingDirectory "torudake-reel-db.sql"
$encryptedPath = "$sqlPath.age"
$manifestPath = Join-Path $workingDirectory "manifest.json"
$resolvedConfig = Join-Path $projectRoot $Config
New-Item -ItemType Directory -Force -Path $workingDirectory | Out-Null

try {
  if ($PSCmdlet.ShouldProcess($Database, "Export remote D1 database")) {
    & pnpm exec wrangler d1 export $Database --remote --config $resolvedConfig --output $sqlPath
    if ($LASTEXITCODE -ne 0) { throw "D1 export failed." }
  }
  if ($PSCmdlet.ShouldProcess($sqlPath, "Encrypt D1 export")) {
    & age -r $AgeRecipient -o $encryptedPath $sqlPath
    if ($LASTEXITCODE -ne 0) { throw "Backup encryption failed." }
  }
  $manifest = [ordered]@{
    schemaVersion = 1
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    database = $Database
    encryptedFile = [System.IO.Path]::GetFileName($encryptedPath)
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $encryptedPath).Hash
    sourceDrive = "D:"
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8

  if ($OffsiteDestination -match "^[^:]+:") {
    if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
      throw "rclone is required for a remote offsite destination."
    }
    if ($PSCmdlet.ShouldProcess($OffsiteDestination, "Copy encrypted backup offsite")) {
      foreach ($file in @($encryptedPath, $manifestPath)) {
        & rclone copyto $file "$($OffsiteDestination.TrimEnd('/'))/$([System.IO.Path]::GetFileName($file))"
        if ($LASTEXITCODE -ne 0) { throw "Offsite copy failed." }
      }
    }
  } else {
    $resolvedOffsite = [System.IO.Path]::GetFullPath($OffsiteDestination)
    if ($resolvedOffsite.StartsWith($resolvedBackupRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "OffsiteDestination must not be inside BackupRoot."
    }
    New-Item -ItemType Directory -Force -Path $resolvedOffsite | Out-Null
    Copy-Item -LiteralPath $encryptedPath, $manifestPath -Destination $resolvedOffsite
  }
} finally {
  if (Test-Path -LiteralPath $sqlPath) {
    Remove-Item -LiteralPath $sqlPath -Force
  }
}

Write-Output $manifestPath
