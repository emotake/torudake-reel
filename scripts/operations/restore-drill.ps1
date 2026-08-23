[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$EncryptedBackup,
  [Parameter(Mandatory = $true)][string]$AgeIdentity,
  [string]$DrillRoot = "D:\TorudakeRestoreDrills",
  [string]$SqliteExecutable = "sqlite3"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$expectedMigrations = @(
  Get-ChildItem -LiteralPath (Join-Path $projectRoot "drizzle") -File -Filter "*.sql" |
    Where-Object { $_.Name -match '^\d{4}_.+\.sql$' } |
    Sort-Object Name |
    ForEach-Object { $_.Name }
)
if ($expectedMigrations.Count -eq 0) { throw "No reviewed migrations were found." }
$resolvedRoot = [System.IO.Path]::GetFullPath($DrillRoot)
if (-not $resolvedRoot.StartsWith("D:\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "DrillRoot must be an explicit directory on drive D:."
}
if (-not (Test-Path -LiteralPath $EncryptedBackup -PathType Leaf)) {
  throw "Encrypted backup not found."
}
if (-not (Test-Path -LiteralPath $AgeIdentity -PathType Leaf)) {
  throw "Age identity not found."
}
if (-not (Get-Command age -ErrorAction SilentlyContinue)) {
  throw "age is required for the restore drill."
}
if (-not (Get-Command $SqliteExecutable -ErrorAction SilentlyContinue)) {
  throw "sqlite3 is required for the restore drill."
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$drillDirectory = Join-Path $resolvedRoot $stamp
$sqlPath = Join-Path $drillDirectory "restore.sql"
$databasePath = Join-Path $drillDirectory "restore.sqlite3"
New-Item -ItemType Directory -Force -Path $drillDirectory | Out-Null

try {
  & age -d -i $AgeIdentity -o $sqlPath $EncryptedBackup
  if ($LASTEXITCODE -ne 0) { throw "Backup decryption failed." }
  Get-Content -Raw -LiteralPath $sqlPath | & $SqliteExecutable $databasePath
  if ($LASTEXITCODE -ne 0) { throw "Local SQLite import failed." }
  $quickCheck = "$(& $SqliteExecutable $databasePath "PRAGMA quick_check;")".Trim()
  $foreignKeys = "$(& $SqliteExecutable $databasePath "PRAGMA foreign_key_check;")".Trim()
  $restoredMigrations = @(
    & $SqliteExecutable -noheader $databasePath "SELECT name FROM d1_migrations ORDER BY id;" |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ }
  )
  if ($LASTEXITCODE -ne 0) { throw "Restored migration ledger could not be read." }
  if ($quickCheck -ne "ok") { throw "Restored database quick_check failed: $quickCheck" }
  if ($foreignKeys) { throw "Restored database has foreign-key violations." }
  $migrationLedgerMatches = $restoredMigrations.Count -eq $expectedMigrations.Count
  if ($migrationLedgerMatches) {
    for ($index = 0; $index -lt $expectedMigrations.Count; $index += 1) {
      if ($restoredMigrations[$index] -ne $expectedMigrations[$index]) {
        $migrationLedgerMatches = $false
        break
      }
    }
  }
  if (-not $migrationLedgerMatches) {
    throw "Restored migration ledger does not exactly match the reviewed repository ledger."
  }

  [ordered]@{
    schemaVersion = 1
    performedAt = (Get-Date).ToUniversalTime().ToString("o")
    encryptedBackup = (Resolve-Path $EncryptedBackup).Path
    quickCheck = $quickCheck
    foreignKeyViolations = 0
    migrationRows = $restoredMigrations.Count
    latestMigration = $expectedMigrations[-1]
    result = "pass"
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $drillDirectory "restore-drill.json") -Encoding utf8
} finally {
  if (Test-Path -LiteralPath $sqlPath) {
    Remove-Item -LiteralPath $sqlPath -Force
  }
  if (Test-Path -LiteralPath $databasePath) {
    Remove-Item -LiteralPath $databasePath -Force
  }
}

Write-Output (Join-Path $drillDirectory "restore-drill.json")
