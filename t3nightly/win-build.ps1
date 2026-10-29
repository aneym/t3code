param([Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Dir)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $Dir
$src = Join-Path $root 'src'
Get-ChildItem $root -Directory | Where-Object { $_.FullName -ne $Dir -and $_.FullName -ne $src } | Sort-Object LastWriteTime -Descending | Select-Object -Skip 1 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$env:Path = "$env:LOCALAPPDATA\vite-plus\bin;" + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
Set-Location $Dir
Remove-Item out, publish -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $src, publish | Out-Null
Get-ChildItem $src -Force | Where-Object { $_.Name -ne 'node_modules' } | Remove-Item -Recurse -Force
tar -xzf src.tgz -C $src
if ($LASTEXITCODE) { throw "extract failed $LASTEXITCODE" }
Remove-Item src.tgz
(Get-Content public-config.json -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { Set-Item -Path "env:$($_.Name)" -Value $_.Value }
Remove-Item public-config.json
$env:T3CODE_DESKTOP_UPDATE_REPOSITORY = 'aneym/t3code'
$env:T3CODE_DESKTOP_UPDATE_URL = 'https://studio.tailf266ac.ts.net:8972/'
Remove-Item env:VITE_HTTP_URL, env:VITE_WS_URL, env:T3CODE_HOME, env:T3CODE_PORT -ErrorAction SilentlyContinue
Set-Location $src
vp i --frozen-lockfile
if ($LASTEXITCODE) { throw "vp i failed $LASTEXITCODE" }
vp run build:desktop
if ($LASTEXITCODE) { throw "build:desktop failed $LASTEXITCODE" }
Copy-Item "$Dir\fork-build.json" apps\server\dist\client\fork-build.json -Force
$env:T3CODE_DESKTOP_SKIP_BUILD = '1'
vp run dist:desktop:artifact --platform win --target nsis --arch x64 --build-version $Version --verbose --output-dir "$Dir\out"
if ($LASTEXITCODE) { throw "artifact failed $LASTEXITCODE" }
Copy-Item "$Dir\out\nightly.yml", "$Dir\out\*.exe", "$Dir\out\*.exe.blockmap" "$Dir\publish"
Get-ChildItem "$Dir\publish" | Select-Object Name, Length | Format-Table -AutoSize
