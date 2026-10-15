import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('verifies both annotated and lightweight remote release tags by commit', () => {
  const source = readFileSync(resolve('scripts/publish-release.ps1'), 'utf8')
  const sourceBase64 = Buffer.from(source, 'utf8').toString('base64')
  const probe = `
$ErrorActionPreference = 'Stop'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${sourceBase64}'))
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'publish-release.ps1 has a parse error.' }
$functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-RemoteReleaseRefs' }, $true))
if ($functions.Count -ne 1) { throw 'Expected one remote-ref validator.' }
. ([ScriptBlock]::Create($functions[0].Extent.Text))

$head = 'a' * 40
$tagObject = 'b' * 40
$other = 'c' * 40
$tab = [char]9
$master = "$head" + $tab + 'refs/heads/master'
$lightweight = "$head" + $tab + 'refs/tags/v0.0.53'
$annotated = "$tagObject" + $tab + 'refs/tags/v0.0.53'
$peeled = "$head" + $tab + 'refs/tags/v0.0.53^{}'

function MustPass([string[]]$refs) {
  Assert-RemoteReleaseRefs -Refs $refs -ExpectedCommit $head -TagName 'v0.0.53'
}
function MustFail([string[]]$refs) {
  $failed = $false
  try { MustPass $refs } catch { $failed = $true }
  if (-not $failed) { throw 'Invalid remote refs were accepted.' }
}

MustPass @($master, $lightweight)
MustPass @($master, $annotated, $peeled)
MustFail @($master, $annotated)
MustFail @($master, $annotated, "$other" + $tab + 'refs/tags/v0.0.53^{}')
MustFail @("$other" + $tab + 'refs/heads/master', $lightweight)
MustFail @($master, $peeled)
MustFail @($master, $lightweight, $lightweight)
MustFail @($master, 'malformed line')
Write-Output 'OK'
`
  const encodedProbe = Buffer.from(probe, 'utf16le').toString('base64')
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedProbe], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  expect(result.trim()).toBe('OK')
})
