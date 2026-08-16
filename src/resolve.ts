// Model-name normalization: turn one stored model string into every
// catalogue key it could plausibly be filed under.
//
// Callers store whatever an agent CLI reported. That naming scheme uses
// dashes between version digits (`claude-opus-4-7`) and sometimes appends a
// release tag (`claude-haiku-4-5-20251001`), while OpenRouter ids use dots
// and no tag (`anthropic/claude-opus-4.7`). We try the literal name first,
// then progressively normalized variants.
//
// Every candidate is probed as an EXACT key, so an over-eager normalization
// misses rather than mis-prices. That property is what makes it safe to be
// generous here.

// Family -> OpenRouter vendor prefix lookup. A backstop only: the catalogue
// is indexed by bare name too (see parseOpenRouterModels), so a bare id
// resolves for every vendor without a rule here. These survive because they
// also let a `vendor/`-prefixed lookup hit the bare-keyed fallback table.
// Do not add a rule per new vendor — the reverse index already covers it.
const VENDOR_PREFIX_BY_FAMILY: Array<{ test: (name: string) => boolean, prefix: string }> = [
  { test: n => n.startsWith('claude-'), prefix: 'anthropic/' },
  { test: n => n.startsWith('gpt-') || n.startsWith('o1-') || n.startsWith('o3-') || n.startsWith('o4-'), prefix: 'openai/' },
  { test: n => n.startsWith('deepseek-'), prefix: 'deepseek/' },
  { test: n => n.startsWith('glm-'), prefix: 'z-ai/' },
  { test: n => n.startsWith('grok-'), prefix: 'x-ai/' },
  { test: n => n.startsWith('gemini-'), prefix: 'google/' },
  { test: n => n.startsWith('llama-'), prefix: 'meta-llama/' },
  { test: n => n.startsWith('qwen'), prefix: 'qwen/' },
  { test: n => n.startsWith('mistral-') || n.startsWith('codestral-'), prefix: 'mistralai/' },
]

// Vendor names that themselves contain a dash, so that a `vendor-model`
// string cannot be split on its first dash. Only these need listing: for
// every single-segment vendor the generic first-dash strip already works.
const DASHED_VENDOR_SEGMENTS = [
  'x-ai',
  'z-ai',
  'meta-llama',
  'zai-org',
  'google-vertex',
  'amazon-bedrock',
  'azure-cognitive-services',
]

/**
 * `claude-opus-4-7` -> `claude-opus-4.7`. The lookahead keeps the regex from
 * chewing through 8-digit date suffixes.
 */
export function dotted(s: string): string {
  return s.replaceAll(/(\D)(\d+)-(\d+)(?=-|$)/g, '$1$2.$3')
}

/**
 * The inverse: `anthropic/claude-opus-4.7` -> `claude-opus-4-7`. Catalogue
 * ids use dots, so a caller who passes one straight through would otherwise
 * miss every dash-keyed table (the snapshot included) and silently price
 * at $0.
 */
export function undotted(s: string): string {
  return s.replaceAll(/(\d)\.(\d)/g, '$1-$2')
}

// Leading `<segment>.` groups Bedrock puts in front of a model id: the
// vendor, optionally behind a region. Matched against a list rather than a
// pattern because `gpt-3.5-turbo` also has a dot after a leading segment,
// and stripping there yields `5-turbo`.
const DOTTED_ID_PREFIXES = new Set([
  'us',
  'eu',
  'apac',
  'us-gov',
  'anthropic',
  'meta',
  'amazon',
  'mistral',
  'cohere',
  'ai21',
  'deepseek',
  'stability',
  'writer',
  'luma',
  'twelvelabs',
  'qwen',
])

/**
 * Strip the decoration a hosting platform or gateway wraps around a
 * vendor's model id, leaving the id the price catalogues actually use.
 *
 * Everything here is still only a *candidate* — probed as an exact key, so
 * an over-eager strip misses rather than mis-prices.
 */
function unwrapPlatformId(model: string): string {
  let id = model
  // Bedrock version suffix: `...-v1:0`, `...-v2:1`.
  id = id.replace(/-v\d+:\d+$/, '')
  // Vertex pins a release with `@`: `claude-opus-4-5@20250514`.
  id = id.replace(/@\d{4,8}$/, '')
  // OpenRouter appends a routing modifier — `:nitro` and `:floor` choose an
  // endpoint for the SAME listed price, so they can be dropped. `:free` is
  // deliberately excluded: it is a different price tier, and resolving it
  // to the paid listing would bill a route that costs nothing.
  if (!id.endsWith(':free')) {
    id = id.replace(/:[a-z][\w-]*$/, '')
  }
  // A deep path — `publishers/anthropic/models/claude-sonnet-4-5`,
  // `accounts/fireworks/models/kimi-k2-instruct`. The id is the last
  // segment; `add()` only ever peels one level.
  if (id.includes('/')) {
    id = id.slice(id.lastIndexOf('/') + 1)
  }
  // Now the dotted Bedrock prefixes, outermost first.
  let dot = id.indexOf('.')
  while (dot > 0 && DOTTED_ID_PREFIXES.has(id.slice(0, dot))) {
    id = id.slice(dot + 1)
    dot = id.indexOf('.')
  }
  return id
}

export function pricingCandidates(model: string): string[] {
  const set = new Set<string>()
  const add = (s: string): void => {
    if (!s) {
      return
    }
    set.add(s)
    // Drop any `vendor/` prefix the caller may have supplied so that the
    // raw model name is still a candidate on its own.
    const stripped = s.replace(/^[^/]+\//, '')
    set.add(stripped)
    // Infer the vendor prefix from the model family.
    for (const { test, prefix } of VENDOR_PREFIX_BY_FAMILY) {
      if (test(stripped)) {
        set.add(`${prefix}${stripped}`)
      }
    }
  }
  // Every spelling variant of one base form: the form itself, its dotted
  // version, and — when it ends in a release tag — the untagged form of
  // both. Tags come in every width vendors have used: `-YYYYMMDD`
  // (`claude-haiku-4-5-20251001`), `-YYMMDD` (`deepseek-v4-flash-260425`),
  // `-MMDD` (`deepseek-v4-pro-0813`) and the moving `-latest`.
  // `add` is Set-backed, so re-adding an unchanged form is a no-op.
  const addAllForms = (form: string): void => {
    // `-YYYY-MM-DD` is the same release tag written with dashes, which is
    // how OpenAI and Bedrock write it. Stripped first so the numeric rule
    // below does not chew off only its last group.
    const untagged = form
      .replace(/-\d{4}-\d{2}-\d{2}$/, '')
      .replace(/-(?:\d{4}|\d{6}|\d{8}|latest)$/, '')
    for (const variant of [form, untagged]) {
      add(variant)
      add(dotted(variant))
      add(undotted(variant))
    }
  }
  // A trailing slash makes the last path segment empty, so every
  // segment-based candidate comes out blank.
  const base = model.toLowerCase().trim().replace(/\/+$/, '')
  addAllForms(base)
  // Some Codex proxies stamp the reasoning effort into the model name
  // (`gpt-5.5(xhigh)`, `gpt-5.4 (high)`). The parenthetical is not part of
  // any catalogue id, and pricing does not vary by effort, so retry without
  // it. Historical rows keep their raw name forever, and users on older CLI
  // builds keep emitting it, so this rule is permanent.
  const deparenthesized = base.replace(/\s*\([^)]*\)\s*$/, '').trim()
  if (deparenthesized && deparenthesized !== base) {
    addAllForms(deparenthesized)
  }
  // Some clients join vendor and model with a `-` instead of a `/`
  // (`deepseek-deepseek-v4-pro`, `openai-gpt-5.6-sol`). Drop the leading
  // segment and let the lookup decide.
  const withoutLeadingSegment = base.slice(base.indexOf('-') + 1)
  if (base.includes('-') && withoutLeadingSegment) {
    addAllForms(withoutLeadingSegment)
  }
  // ...which is not enough when the vendor's own name contains a dash.
  // `x-ai-grok-4` would strip to `ai-grok-4` and miss everything. Strip by
  // known vendor name rather than by position. Stripping every leading
  // segment in turn would also work, but it manufactures candidates like
  // `4-5` out of `claude-opus-4-5`, and a junk key that happens to exist
  // upstream prices the wrong model.
  for (const vendor of DASHED_VENDOR_SEGMENTS) {
    if (base.startsWith(`${vendor}-`)) {
      addAllForms(base.slice(vendor.length + 1))
    }
  }
  // Hosted platforms and gateways wrap the vendor's own id in their own
  // decoration. Peel it off and try what is underneath.
  const unwrapped = unwrapPlatformId(base)
  if (unwrapped !== base) {
    addAllForms(unwrapped)
  }
  return [...set]
}
