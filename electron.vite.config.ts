import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        input: {
          avatar: resolve(__dirname, 'src/renderer/avatar.html')
        }
      }
    }
  }
})
