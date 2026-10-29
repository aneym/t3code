param([Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Dir)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $Dir
Get-ChildItem $root -Directory | Where-Object { $_.FullName -ne $Dir } | Sort-Object LastWriteTime -Descending | Select-Object -Skip 1 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Set-Location $Dir
Remove-Item src, out, publish -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force src, publish | Out-Null
tar -xzf src.tgz -C src
if ($LASTEXITCODE) { throw "extract failed $LASTEXITCODE" }
Remove-Item src.tgz
if (-not (Get-Command vp -ErrorAction SilentlyContinue)) {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
}
Get-Content public-config.env | ForEach-Object { if ($_ -match '^([A-Z0-9_]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] } }
Remove-Item public-config.env
$env:T3CODE_DESKTOP_UPDATE_REPOSITORY = 'aneym/t3code'
$env:T3CODE_DESKTOP_UPDATE_URL = 'https://studio.tailf266ac.ts.net:8972/'
Remove-Item env:VITE_HTTP_URL, env:VITE_WS_URL, env:T3CODE_HOME, env:T3CODE_PORT -ErrorAction SilentlyContinue
Set-Location src
vp i --frozen-lockfile
if ($LASTEXITCODE) { throw "vp i failed $LASTEXITCODE" }
vp run build:desktop
if ($LASTEXITCODE) { throw "build:desktop failed $LASTEXITCODE" }
Copy-Item ..\fork-build.json apps\server\dist\client\fork-build.json -Force
$env:T3CODE_DESKTOP_SKIP_BUILD = '1'
vp run dist:desktop:artifact --platform win --target nsis --arch x64 --build-version $Version --verbose --output-dir "$Dir\out"
if ($LASTEXITCODE) { throw "artifact failed $LASTEXITCODE" }
Copy-Item "$Dir\out\nightly.yml", "$Dir\out\*.exe", "$Dir\out\*.exe.blockmap" "$Dir\publish"
Remove-Item "$Dir\src" -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem "$Dir\publish" | Select-Object Name, Length | Format-Table -AutoSize
