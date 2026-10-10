import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // reference/claudian is a read-only checkout of the upstream plugin; its
    // jest-based tests are not ours and must not be collected by `vitest run`.
    exclude: [...configDefaults.exclude, 'reference/**']
  }
})
