import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // reference/claudian is a read-only checkout of the upstream plugin; its
    // jest-based tests are not ours and must not be collected by `vitest run`.
    // `.tmp` holds packaged skill checkouts and one-off render scripts.
    exclude: [...configDefaults.exclude, 'reference/**', '.tmp/**']
  }
})
