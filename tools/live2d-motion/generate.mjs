#!/usr/bin/env node
/** Generate the tracked Arch-chan state motions from their single definition. */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { curve, motion } from './motion-core.mjs'
import { define } from './definitions/arch-chan.mjs'

const toolDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(toolDir, '../..')
const modelDir = path.join(projectRoot, 'resources', 'live2d', 'arch-chan')
const outputs = {
  idle: path.join(modelDir, 'motions', 'idle.motion3.json'),
  thinking: path.join(modelDir, 'motions', 'thinking.motion3.json'),
  working: path.join(modelDir, 'motions', 'working.motion3.json'),
  listening: path.join(modelDir, 'motions', 'listening.motion3.json'),
  speaking: path.join(modelDir, 'motions', 'speaking.motion3.json'),
  waiting: path.join(modelDir, 'motions', 'waiting.motion3.json'),
  verifying: path.join(modelDir, 'motions', 'verifying.motion3.json'),
  poke: path.join(modelDir, 'motions', 'poke.motion3.json')
}

function encoded(document) {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

function writeAtomic(target, payload) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}`)
  try {
    fs.writeFileSync(temporary, payload)
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function main(args) {
  if (args.some((argument) => argument !== '--check')) {
    throw new Error('usage: node tools/live2d-motion/generate.mjs [--check]')
  }
  const check = args.includes('--check')
  const definitions = define({ curve, motion })
  const expected = Object.keys(outputs).sort()
  const actual = Object.keys(definitions).sort()
  if (actual.join('\0') !== expected.join('\0')) {
    throw new Error(`definition/output mismatch: definitions=${actual.join(',')}, outputs=${expected.join(',')}`)
  }

  const stale = []
  for (const [name, output] of Object.entries(outputs)) {
    const payload = encoded(definitions[name])
    const relative = path.relative(projectRoot, output)
    if (check) {
      if (!fs.existsSync(output) || !fs.readFileSync(output).equals(payload)) {
        stale.push(relative)
        console.log(`OUTDATED: ${relative}`)
      } else {
        console.log(`OK: ${relative}`)
      }
    } else {
      writeAtomic(output, payload)
      console.log(`wrote: ${relative}`)
    }
  }
  if (stale.length) {
    console.error('Run npm run live2d:generate to refresh generated motion files.')
    return 1
  }
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
