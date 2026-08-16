import { describe, expect, it } from 'vitest'
import { configureDefaultCatalog, getDefaultCatalog } from '../src/index'

// Its own file: the default catalogue is module state, and these assertions
// are about the order things happen in. Vitest isolates per file, so this
// cannot leak into another suite.
describe('default catalogue', () => {
  it('applies configuration and hands back the instance', () => {
    // `sources: []` keeps the test offline — no source means the bundled
    // archive and the overrides answer everything.
    const catalog = configureDefaultCatalog({ sources: [] })
    expect(getDefaultCatalog()).toBe(catalog)
    expect(catalog.getPrice('deepseek-v4-pro')).not.toBeNull()
  })

  it('refuses to reconfigure a catalogue already in use', () => {
    // The alternative is silently ignoring the options, which leaves a
    // whole process running on an unconfigured catalogue.
    expect(() => configureDefaultCatalog({ sources: [] })).toThrow(/already in use/)
  })
})
