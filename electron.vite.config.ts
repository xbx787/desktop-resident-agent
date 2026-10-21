import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          settings: resolve(__dirname, 'src/preload/settings.ts'),
          onboarding: resolve(__dirname, 'src/preload/onboarding.ts')
        }
      }
    }
  },
  renderer: {
    // Live2D model JSON resolves its textures, physics and expressions via
    // relative URLs. Keep the whole resource tree intact beside avatar.html
    // instead of emitting hashed individual files.
    publicDir: resolve(__dirname, 'resources'),
    build: {
      copyPublicDir: true,
      rollupOptions: {
        input: {
          avatar: resolve(__dirname, 'src/renderer/avatar.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          onboarding: resolve(__dirname, 'src/renderer/onboarding.html')
        }
      }
    }
  }
})
