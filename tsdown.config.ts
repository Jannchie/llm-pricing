import { defineConfig } from 'tsdown'

export default defineConfig({
  // `node` is a separate entry so the main one stays free of `node:`
  // imports and still bundles for workers and the browser.
  entry: ['src/index.ts', 'src/node.ts', 'src/internal.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  treeshake: true,
})
