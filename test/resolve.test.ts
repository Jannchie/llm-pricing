import { describe, expect, it } from 'vitest'
import { dotted, pricingCandidates } from '../src/resolve'

describe('dotted', () => {
  it('joins version digits with a dot', () => {
    expect(dotted('claude-opus-4-7')).toBe('claude-opus-4.7')
    expect(dotted('gpt-5-1-codex')).toBe('gpt-5.1-codex')
  })

  it('leaves an 8-digit release tag alone', () => {
    // The lookahead is what stops `4-5-20251001` collapsing into a version.
    expect(dotted('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5-20251001')
  })
})

function has(model: string, candidate: string): boolean {
  return pricingCandidates(model).includes(candidate)
}

describe('pricingcandidates', () => {
  it('keeps the literal name', () => {
    expect(has('claude-opus-4-7', 'claude-opus-4-7')).toBe(true)
  })

  it('lowercases', () => {
    expect(has('GPT-5.6-Sol', 'gpt-5.6-sol')).toBe(true)
  })

  it('produces the dotted spelling used by remote catalogues', () => {
    expect(has('claude-opus-4-7', 'claude-opus-4.7')).toBe(true)
  })

  it('produces the dashed spelling used by stored model strings', () => {
    // A caller passing a catalogue id straight through must still hit the
    // dash-keyed snapshot rather than silently pricing at $0.
    expect(has('anthropic/claude-opus-4.7', 'claude-opus-4-7')).toBe(true)
  })

  it('infers the vendor prefix by family', () => {
    expect(has('claude-opus-4-7', 'anthropic/claude-opus-4.7')).toBe(true)
    expect(has('gpt-5.5', 'openai/gpt-5.5')).toBe(true)
    expect(has('deepseek-v4-pro', 'deepseek/deepseek-v4-pro')).toBe(true)
  })

  it('strips a supplied vendor prefix', () => {
    expect(has('anthropic/claude-opus-5', 'claude-opus-5')).toBe(true)
  })

  it.each([
    ['claude-haiku-4-5-20251001', 'claude-haiku-4.5'],
    ['deepseek-v4-flash-260425', 'deepseek-v4-flash'],
    ['deepseek-v4-pro-0813', 'deepseek-v4-pro'],
    ['claude-sonnet-5-latest', 'claude-sonnet-5'],
  ])('drops the release tag on %s', (model, expected) => {
    expect(has(model, expected)).toBe(true)
  })

  it('drops a codex reasoning-effort parenthetical', () => {
    expect(has('gpt-5.5(xhigh)', 'gpt-5.5')).toBe(true)
    expect(has('gpt-5.4 (high)', 'gpt-5.4')).toBe(true)
  })

  it('drops a dash-joined vendor segment', () => {
    expect(has('deepseek-deepseek-v4-pro', 'deepseek-v4-pro')).toBe(true)
    expect(has('openai-gpt-5.6-sol', 'gpt-5.6-sol')).toBe(true)
  })

  it('returns no duplicates', () => {
    const candidates = pricingCandidates('anthropic/claude-haiku-4-5-20251001')
    expect(candidates.length).toBe(new Set(candidates).size)
  })

  it('never returns an empty string', () => {
    expect(pricingCandidates('gpt-5')).not.toContain('')
  })
})
