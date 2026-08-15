import type { PriceSchedule } from '../types'
import { flatSchedule, scaleSchedule } from '../rates'
import snapshot from './snapshot.json'

// The offline table, used when no remote source is reachable or none of
// them lists a model.
//
// Its price rows are NOT hand-maintained: `snapshot.json` is generated from
// models.dev by `pnpm sync`, filtered to first-party providers so a bare
// model name resolves to the rate a user calling the vendor directly would
// pay. The sync is append-only, which is what keeps retired-but-still-stored
// model strings priced instead of silently costing $0.
//
// What IS hand-maintained here is the one thing no upstream publishes: the
// fast/priority tier multipliers below.

type SnapshotRow = [displayName: string, input: number, cacheWrite: number, cacheRead: number, output: number]

const FALLBACK: Record<string, PriceSchedule> = {}

// The JSON's inferred type is `(string | number)[]`, which cannot express a
// fixed-arity tuple; the shape is guaranteed by the generator instead.
const SNAPSHOT_MODELS = snapshot.models as unknown as Record<string, SnapshotRow>

for (const [id, row] of Object.entries(SNAPSHOT_MODELS)) {
  const [displayName, input, cacheWrite, cacheRead, output] = row
  FALLBACK[id] = flatSchedule(displayName, input / 1e6, cacheRead / 1e6, output / 1e6, cacheWrite / 1e6)
}

/** When the bundled snapshot was last refreshed (YYYY-MM-DD). */
export const SNAPSHOT_SYNCED_AT: string = snapshot.syncedAt

// Fast / priority inference variants.
//
// No catalogue publishes these: OpenRouter lists no `gpt-5.x-fast` model at
// all, models.dev has no fast tier, and Anthropic's fast variants vanish
// from catalogues when they retire upstream. So the multipliers live here,
// applied to whatever base model the snapshot provides.
//
// The multiplier is NOT constant: Opus 4.6/4.7 x6 ($30/$150), Opus 4.8 x2
// ($10/$50, Anthropic's published fast-mode rate), gpt-5.5 x2.5, gpt-5.4 /
// gpt-5.3-codex x2. Opus 5 follows 4.8; the rest of the Codex tiers use x2
// as the house default, since upstream has not published a rate for them.
// Sonnet and Haiku have no fast variant — do not synthesize one.
//
// Append-only, like the snapshot: never drop a row because upstream retired
// the model, or its historical rows silently price at $0.
const FAST_MULTIPLIERS: Array<[multiplier: number, baseIds: string[]]> = [
  [6, ['claude-opus-4-6', 'claude-opus-4-7']],
  [2, ['claude-opus-4-8', 'claude-opus-5']],
  [2.5, ['gpt-5.5']],
  [2, [
    'gpt-5',
    'gpt-5-codex',
    'gpt-5.1',
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.2-codex',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.6-sol',
    'gpt-5.6-luna',
    'gpt-5.6-terra',
  ]],
]

for (const [multiplier, baseIds] of FAST_MULTIPLIERS) {
  for (const id of baseIds) {
    const base = FALLBACK[id]
    if (base) {
      FALLBACK[`${id}-fast`] = scaleSchedule(base, multiplier, 'Fast')
    }
  }
}

export { FALLBACK, FAST_MULTIPLIERS }
