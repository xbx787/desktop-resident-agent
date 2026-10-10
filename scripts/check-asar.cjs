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

if (!fs.existsSync(archive)) {
  throw new Error(`Packaged app not found: ${archive}`)
}

const files = asar.listPackage(archive).map((name) => name.replace(/^[/\\]/u, '').replaceAll('\\', '/'))
const required = ['package.json', 'out/main/index.js', 'out/preload/settings.js', 'out/renderer/avatar.html', 'out/renderer/settings.html']
const missing = required.filter((name) => !files.includes(name))
const bundledVersion = JSON.parse(asar.extractFile(archive, 'package.json').toString()).version
const assetFiles = files.filter((name) => /^out\/(main|renderer|preload)\//u.test(name) && /\.(js|css)$/u.test(name))
const assetText = markers.length ? assetFiles.map((name) => [name, asar.extractFile(archive, name.split('/').join(path.sep)).toString()]) : []
const markerResults = markers.map((marker) => ({
  marker,
  file: assetText.find(([, contents]) => contents.includes(marker))?.[0] || null,
}))
const result = { archive, expectedVersion: version, bundledVersion, missing, markers: markerResults }
console.log(JSON.stringify(result, null, 2))
if (bundledVersion !== version || missing.length || markerResults.some((item) => !item.file)) process.exitCode = 1
