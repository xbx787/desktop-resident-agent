param([Parameter(Mandatory=$true)][string]$Version)

$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid version.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $root
$tag = "v$Version"
$name = "whale-companion-$tag"
$releaseDir = Join-Path $root (Join-Path 'release' $name)
$zip = Join-Path $root (Join-Path 'release' "$name-win-x64.zip")
$sum = Join-Path $root (Join-Path 'release' "$name.sha256.txt")
$notes = Join-Path $releaseDir 'RELEASE_NOTES.md'
foreach ($file in @($zip, $sum, $notes)) { if (-not (Test-Path -LiteralPath $file)) { throw "Release file missing: $file" } }
$localVersion = (& node -p "require('./package.json').version").Trim()
if ($LASTEXITCODE -ne 0 -or $localVersion -ne $Version) { throw 'Package version does not match release.' }
$dirty = & git status --porcelain
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Working tree must be clean before publishing.' }
$head = (& git rev-parse HEAD).Trim()
$tagHead = (& git rev-list -n 1 $tag).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $tagHead) { throw 'Release tag must point to HEAD.' }
$expected = (Get-Content -LiteralPath $sum -TotalCount 1).Split(' ')[0]
$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Archive checksum mismatch.' }
$repository = & gh repo view --json isPrivate,nameWithOwner | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $repository.isPrivate) { throw 'GitHub repository must be private.' }
& git push origin HEAD:master
if ($LASTEXITCODE -ne 0) { throw 'Branch push failed.' }
& git push origin $tag
if ($LASTEXITCODE -ne 0) { throw 'Tag push failed.' }
$previousErrorActionPreference = $ErrorActionPreference
try {
  # Windows PowerShell can turn gh's "release not found" stderr into a terminating error.
  $ErrorActionPreference = 'Continue'
  $releaseLookup = @(& gh release view $tag --json tagName 2>&1)
  $releaseLookupExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
if ($releaseLookupExitCode -ne 0 -and (@($releaseLookup) -join "`n") -notmatch '(?i)\brelease not found\b') {
  throw 'GitHub Release lookup failed.'
}
if ($releaseLookupExitCode -ne 0) {
  & gh release create $tag $zip $sum --title "$name" --notes-file $notes --verify-tag
  if ($LASTEXITCODE -ne 0) { throw 'GitHub Release creation failed.' }
} else {
  & gh release edit $tag --title $name --notes-file $notes
  if ($LASTEXITCODE -ne 0) { throw 'GitHub Release notes update failed.' }
  $assets = & gh release view $tag --json assets --jq '.assets[].name'
  if ($LASTEXITCODE -ne 0) { throw 'GitHub Release inspection failed.' }
  if ($assets -notcontains [IO.Path]::GetFileName($zip)) {
    & gh release upload $tag $zip
    if ($LASTEXITCODE -ne 0) { throw 'Archive upload failed.' }
  }
  if ($assets -notcontains [IO.Path]::GetFileName($sum)) {
    & gh release upload $tag $sum
    if ($LASTEXITCODE -ne 0) { throw 'Checksum upload failed.' }
  }
}
function Assert-RemoteReleaseRefs {
  param(
    [Parameter(Mandatory=$true)][string[]]$Refs,
    [Parameter(Mandatory=$true)][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][string]$TagName
  )

  $masterRef = 'refs/heads/master'
  $tagRef = "refs/tags/$TagName"
  $peeledTagRef = "${tagRef}^{}"
  $found = @{}
  foreach ($line in $Refs) {
    $parts = $line -split "`t", 2
    if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[0-9a-f]{40}$' -or $parts[1] -notmatch '^refs/') {
      throw 'Remote refs readback returned an invalid line.'
    }
    if ($found.ContainsKey($parts[1])) { throw 'Remote refs readback returned a duplicate ref.' }
    $found.Add($parts[1], $parts[0])
  }

  if (-not $found.ContainsKey($masterRef) -or -not $found.ContainsKey($tagRef)) {
    throw 'Remote branch or tag is missing.'
  }
  $tagCommit = if ($found.ContainsKey($peeledTagRef)) { $found[$peeledTagRef] } else { $found[$tagRef] }
  if ($found[$masterRef] -ne $ExpectedCommit -or $tagCommit -ne $ExpectedCommit) {
    throw 'Remote branch or tag does not point to the release commit.'
  }
}

$remoteRefs = & git ls-remote origin refs/heads/master "refs/tags/$tag" "refs/tags/$tag^{}"
if ($LASTEXITCODE -ne 0) { throw 'Remote refs readback failed.' }
Assert-RemoteReleaseRefs -Refs @($remoteRefs) -ExpectedCommit $head -TagName $tag
$release = & gh release view $tag --json tagName,assets,url,body | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $release.tagName -ne $tag) { throw 'GitHub Release readback failed.' }
$names = @($release.assets | ForEach-Object { $_.name })
if ($names -notcontains [IO.Path]::GetFileName($zip) -or $names -notcontains [IO.Path]::GetFileName($sum)) {
  throw 'GitHub Release assets are incomplete.'
}
$publishedNotes = $release.body.Trim().Replace("`r`n", "`n")
$expectedNotes = (Get-Content -LiteralPath $notes -Raw -Encoding UTF8).Trim().Replace("`r`n", "`n")
if ($publishedNotes -ne $expectedNotes) { throw 'GitHub Release notes differ from local notes.' }
Write-Output "Release published: $($release.url)"
Write-Output "Repository: $($repository.nameWithOwner)"
