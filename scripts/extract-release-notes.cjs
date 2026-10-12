const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const version = process.argv[2] || require(path.join(root, 'package.json')).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid version')
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const escaped = version.replace(/\./g, '\\.')
const heading = new RegExp(`^## \\[${escaped}\\].*$`, 'm')
const start = changelog.search(heading)
if (start < 0) throw new Error(`Missing CHANGELOG section for ${version}`)
const rest = changelog.slice(start)
const next = rest.slice(3).search(/^## \[/m)
const notes = (next < 0 ? rest : rest.slice(0, next + 3)).trim() + '\n'
const dir = path.join(root, 'release', `whale-companion-v${version}`)
fs.mkdirSync(dir, { recursive: true })
const target = path.join(dir, 'RELEASE_NOTES.md')
fs.writeFileSync(target, notes, 'utf8')
process.stdout.write(target + '\n')
