const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')

const projectRoot = path.resolve(__dirname, '..')
const version = require(path.join(projectRoot, 'package.json')).version
const archive = path.resolve(
  projectRoot,
  process.env.ASAR_ARCHIVE || `release/whale-companion-v${version}/win-unpacked/resources/app.asar`,
)
const markers = process.argv.slice(2)

function normalized(relative) {
  return relative.replaceAll('\\', '/')
}

function walkFiles(root, current = root) {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) return walkFiles(root, full)
    return entry.isFile() ? [normalized(path.relative(root, full))] : []
  })
}

function sha256(buffer) {
  return require('node:crypto').createHash('sha256').update(buffer).digest('hex')
}

if (!fs.existsSync(archive)) {
  throw new Error(`Packaged app not found: ${archive}`)
}

const files = asar.listPackage(archive).map((name) => name.replace(/^[/\\]/u, '').replaceAll('\\', '/'))
const required = ['package.json', 'out/main/index.js', 'out/preload/settings.js', 'out/renderer/avatar.html', 'out/renderer/settings.html']
const missing = required.filter((name) => !files.includes(name))
const extract = (name) => asar.extractFile(archive, name.split('/').join(path.sep))
const bundledVersion = JSON.parse(extract('package.json').toString()).version
const assetFiles = files.filter((name) => /^out\/(main|renderer|preload)\//u.test(name) && /\.(js|css)$/u.test(name))
const assetText = markers.length ? assetFiles.map((name) => [name, extract(name).toString()]) : []
const markerResults = markers.map((marker) => ({
  marker,
  file: assetText.find(([, contents]) => contents.includes(marker))?.[0] || null,
}))
const outputRoot = path.join(projectRoot, 'out')
const outputFiles = fs.existsSync(outputRoot) ? walkFiles(outputRoot).map((name) => `out/${name}`) : []
const sourceMismatches = outputFiles.flatMap((name) => {
  if (!files.includes(name)) return [{ file: name, reason: 'missing-from-archive' }]
  const source = fs.readFileSync(path.join(projectRoot, name))
  const packaged = extract(name)
  return sha256(source) === sha256(packaged) ? [] : [{ file: name, reason: 'content-differs' }]
})
const result = {
  archive,
  expectedVersion: version,
  bundledVersion,
  missing,
  markers: markerResults,
  sourceOutput: fs.existsSync(outputRoot) ? { files: outputFiles.length, mismatches: sourceMismatches } : null,
}
console.log(JSON.stringify(result, null, 2))
if (bundledVersion !== version || missing.length || markerResults.some((item) => !item.file) || sourceMismatches.length) process.exitCode = 1
