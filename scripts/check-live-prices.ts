import { getDefaultCatalog, pricingCandidates } from '../src/index'

// Model strings shaped the way agent CLIs and codetime rows actually
// store them: bare ids, dated ids, vendor-prefixed, dotted, effort
// parentheticals, fast tiers, slash-qualified.
const CASES: Array<[string, string]> = [
  ['anthropic', 'claude-opus-4-7'],
  ['anthropic', 'claude-opus-4.7'],
  ['anthropic', 'anthropic/claude-opus-4.7'],
  ['anthropic', 'claude-haiku-4-5-20251001'],
  ['anthropic', 'claude-sonnet-4-5'],
  ['anthropic', 'claude-opus-5'],
  ['anthropic', 'claude-opus-5-fast'],
  ['anthropic', 'claude-3-5-haiku-20241022'],
  ['openai', 'gpt-5.5'],
  ['openai', 'gpt-5-5'],
  ['openai', 'gpt-5.5(xhigh)'],
  ['openai', 'gpt-5.1-codex'],
  ['openai', 'gpt-5.1-codex-max'],
  ['openai', 'openai/gpt-5.5'],
  ['openai', 'gpt-4o-mini'],
  ['openai', 'o3'],
  ['openai', 'o4-mini'],
  ['deepseek', 'deepseek-chat'],
  ['deepseek', 'deepseek-v4-pro'],
  ['deepseek', 'deepseek-deepseek-v4-pro'],
  ['deepseek', 'deepseek/deepseek-v3.2'],
  ['deepseek', 'deepseek-reasoner'],
  ['google', 'gemini-3-pro'],
  ['google', 'gemini-2.5-flash'],
  ['google', 'google/gemini-2.5-pro'],
  ['google', 'gemini-2-5-flash-lite'],
  ['xai', 'grok-4'],
  ['xai', 'x-ai/grok-4-fast'],
  ['xai', 'grok-code-fast-1'],
  ['qwen', 'qwen3-coder-plus'],
  ['qwen', 'qwen/qwen3-max'],
  ['zai', 'glm-4.6'],
  ['zai', 'z-ai/glm-4.6'],
  ['zai', 'glm-4-6'],
  ['mistral', 'mistral-large-latest'],
  ['mistral', 'codestral-latest'],
  ['meta', 'llama-4-maverick'],
  ['meta', 'meta-llama/llama-3.3-70b-instruct'],
  ['moonshot', 'kimi-k2-thinking'],
  ['moonshot', 'moonshotai/kimi-k2'],
  ['amazon', 'amazon/nova-pro'],
  ['cohere', 'command-a'],
]

const catalog = getDefaultCatalog()
await catalog.ensureLoaded()
console.log('catalogue:', JSON.stringify(catalog.state()))

const per = new Map<string, { hit: number, total: number }>()
const misses: string[] = []
const rows: string[] = []

for (const [vendor, model] of CASES) {
  const p = catalog.getPrice(model)
  const stat = per.get(vendor) ?? { hit: 0, total: 0 }
  stat.total++
  const ok = p != null && p.source !== 'missing' && p.inputCostPerToken > 0
  if (ok) {
    stat.hit++
  }
  else {
    misses.push(`${model}  [tried: ${pricingCandidates(model).slice(0, 6).join(', ')}]`)
  }
  per.set(vendor, stat)
  const inM = p ? (p.inputCostPerToken * 1e6).toFixed(3) : '-'
  const outM = p ? (p.outputCostPerToken * 1e6).toFixed(3) : '-'
  rows.push(`${ok ? 'OK  ' : 'MISS'} ${model.padEnd(38)} ${String(p?.source ?? '-').padEnd(10)} in $${inM.padStart(8)}/M  out $${outM.padStart(8)}/M  ${p?.displayName ?? ''}`)
}

console.log(rows.join('\n'))
console.log('\n--- per vendor ---')
for (const [v, s] of [...per].sort()) console.log(`${v.padEnd(10)} ${s.hit}/${s.total}`)
const hit = [...per.values()].reduce((a, s) => a + s.hit, 0)
console.log(`\ntotal ${hit}/${CASES.length}`)
if (misses.length > 0) {
  console.log(`\n--- misses ---\n${misses.join('\n')}`)
}
