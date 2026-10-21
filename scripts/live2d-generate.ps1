param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $ForwardedArgs
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectRoot 'tools\live2d-motion\generate.mjs'
$node = Get-Command node -ErrorAction Stop
& $node.Source $entry @ForwardedArgs
exit $LASTEXITCODE
