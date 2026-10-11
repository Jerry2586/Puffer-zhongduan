param(
  [int]$Port = 8792,
  [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'Programs\UniAppTools\projects\hetun-terminal'),
  [string]$NodePath = ''
)
$ErrorActionPreference = 'Stop'
$SourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ResolvedRuntime = [IO.Path]::GetFullPath($RuntimeRoot)
if ($ResolvedRuntime.Equals($SourceRoot, [StringComparison]::OrdinalIgnoreCase) -or $ResolvedRuntime.StartsWith($SourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '运行目录必须位于项目源码之外。' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw '端口必须为 1024–65535。' }
if (-not $NodePath) {
  $BundledNode = Join-Path $env:LOCALAPPDATA 'Programs\UniAppTools\development\node\node.exe'
  if (Test-Path -LiteralPath $BundledNode) { $NodePath = $BundledNode } else { $NodePath = (Get-Command node -ErrorAction Stop).Source }
}
$NodePath = [IO.Path]::GetFullPath($NodePath)
$StatePath = Join-Path $ResolvedRuntime 'state'
New-Item -ItemType Directory -Path $StatePath -Force | Out-Null
$env:HETUN_TERMINAL_STATE = $StatePath
$env:HETUN_TERMINAL_HOST = '127.0.0.1'
$env:HETUN_TERMINAL_PORT = [string]$Port
$env:HETUN_TERMINAL_ORIGIN = 'http://127.0.0.1:' + $Port
Write-Host ('本地地址：http://127.0.0.1:' + $Port)
Write-Host ('初始凭据文件：' + (Join-Path $StatePath 'bootstrap-admin.txt'))
& $NodePath (Join-Path $SourceRoot 'server\index.mjs')
exit $LASTEXITCODE
