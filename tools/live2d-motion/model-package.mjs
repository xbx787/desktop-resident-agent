/** Validate a Cubism model's complete local resource graph before loading it. */
import fs from 'node:fs'
import path from 'node:path'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/** No URL syntax, Windows paths, parent components or nested URL encodings. */
function localReference(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) return null
  let decoded
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return null
  }
  if (/[\\\u0000-\u001f\u007f:#?<>"|*%]/u.test(decoded)) return null
  if (decoded.startsWith('/') || path.posix.isAbsolute(decoded) || path.win32.isAbsolute(decoded)) return null
  if (decoded.split('/').some((part) => part === '..' || part === '')) return null
  return decoded
}

/**
 * `modelPath` is a trusted local entry selected by the host. Every FileReference
 * must stay within its directory, including after following filesystem links.
 * No referenced file is read until both lexical and realpath checks pass.
 */
export function validateModelPackage(modelPath) {
  const errors = []
  const files = []
  let model
  let root
  const fail = (field, value, reason) => errors.push(`${field} (${JSON.stringify(value) ?? 'missing'}): ${reason}`)
  try {
    const stat = fs.statSync(modelPath)
    if (!stat.isFile() || stat.size === 0) throw new Error('must be a nonempty regular file')
    root = fs.realpathSync(path.dirname(modelPath))
    if (!isInside(root, fs.realpathSync(modelPath))) throw new Error('model entry escapes its package directory')
    model = JSON.parse(fs.readFileSync(modelPath, 'utf8').replace(/^\uFEFF/u, ''))
  } catch (error) {
    fail('model3', path.basename(modelPath), error instanceof Error ? error.message : String(error))
    return { errors, files }
  }
  if (!isRecord(model) || model.Version !== 3) errors.push('model3.Version: expected 3')
  const refs = model?.FileReferences
  if (!isRecord(refs)) {
    errors.push('FileReferences: expected an object')
    return { errors, files }
  }
  const inspect = (field, value) => {
    const decoded = localReference(value)
    if (decoded === null) {
      fail(field, value, 'expected a local relative file path without URL syntax or parent traversal')
      return
    }
    const target = path.resolve(root, decoded)
    if (!isInside(root, target)) {
      fail(field, value, 'path escapes the model package')
      return
    }
    try {
      const realTarget = fs.realpathSync(target)
      if (!isInside(root, realTarget)) {
        fail(field, value, 'resolved path escapes the model package')
        return
      }
      const stat = fs.statSync(realTarget)
      if (!stat.isFile() || stat.size === 0) {
        fail(field, value, 'expected a nonempty regular file')
        return
      }
      files.push({ field, path: value })
    } catch (error) {
      const reason = error?.code === 'ENOENT' ? 'referenced file is missing' : 'referenced file is inaccessible'
      fail(field, value, reason)
    }
  }
  inspect('FileReferences.Moc', refs.Moc)
  if (!Array.isArray(refs.Textures) || refs.Textures.length === 0) {
    errors.push('FileReferences.Textures: expected a nonempty array')
  } else {
    refs.Textures.forEach((value, index) => inspect(`FileReferences.Textures[${index}]`, value))
  }
  for (const field of ['Physics', 'DisplayInfo', 'Pose']) {
    if (Object.hasOwn(refs, field)) inspect(`FileReferences.${field}`, refs[field])
  }
  if (Object.hasOwn(refs, 'Expressions')) {
    if (!Array.isArray(refs.Expressions)) errors.push('FileReferences.Expressions: expected an array')
    else refs.Expressions.forEach((entry, index) => inspect(`FileReferences.Expressions[${index}].File`, entry?.File))
  }
  if (Object.hasOwn(refs, 'Motions')) {
    if (!isRecord(refs.Motions)) errors.push('FileReferences.Motions: expected an object')
    else for (const [group, entries] of Object.entries(refs.Motions)) {
      const field = `FileReferences.Motions[${JSON.stringify(group)}]`
      if (!Array.isArray(entries)) {
        errors.push(`${field}: expected an array`)
        continue
      }
      entries.forEach((entry, index) => {
        inspect(`${field}[${index}].File`, entry?.File)
        if (isRecord(entry) && Object.hasOwn(entry, 'Sound')) inspect(`${field}[${index}].Sound`, entry.Sound)
      })
    }
  }
  return { errors, files }
}
