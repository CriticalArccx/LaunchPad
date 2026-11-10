# Windows wrapper for setup-test-db.mjs (ARC-326). See test-env/README.md.
#
#   .\test-env\setup-test-db.ps1 -Template <prefix> -Owner you@example.com [-Reset]
#
# Asks for both connection strings without showing them, so the database
# passwords never land in a file or your PowerShell history, and clears them
# when it finishes.
param(
    [Parameter(Mandatory = $true)][string]$Template,
    [Parameter(Mandatory = $true)][string]$Owner,
    [switch]$Reset
)

function Read-Secret([string]$Prompt) {
    $s = Read-Host $Prompt -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

# pg_dump / psql: use the PATH, else the newest PostgreSQL install.
if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
    $bin = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue |
        Sort-Object { [int]($_.Directory.Parent.Name -replace '\D', '') } -Descending | Select-Object -First 1
    if (-not $bin) {
        Write-Error 'pg_dump not found. Install the PostgreSQL 17 client tools first (see test-env/README.md, step 2).'
        exit 1
    }
    $env:Path = $bin.DirectoryName + ';' + $env:Path
}

$hadProd = [bool]$env:LP_PROD_DB_URL
$hadTest = [bool]$env:LP_TEST_DB_URL
if (-not $hadProd) { $env:LP_PROD_DB_URL = Read-Secret 'PRODUCTION connection string (Session pooler, read only)' }
if (-not $hadTest) { $env:LP_TEST_DB_URL = Read-Secret 'TEST project connection string (Session pooler)' }

$nodeArgs = @('--template', $Template, '--owner', $Owner)
if ($Reset) { $nodeArgs += '--reset' }
try {
    node (Join-Path $PSScriptRoot 'setup-test-db.mjs') @nodeArgs
    $code = $LASTEXITCODE
} finally {
    if (-not $hadProd) { Remove-Item Env:LP_PROD_DB_URL -ErrorAction SilentlyContinue }
    if (-not $hadTest) { Remove-Item Env:LP_TEST_DB_URL -ErrorAction SilentlyContinue }
}
exit $code
