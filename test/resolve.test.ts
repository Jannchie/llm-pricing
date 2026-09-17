import { describe, expect, it } from 'vitest'
import { dotted, familyFirst, peelRoutingTiers, pricingCandidates } from '../src/resolve'

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

describe('familyfirst', () => {
  it.each([
    ['claude-4.6-opus', 'claude-opus-4.6'],
    ['claude-4-6-opus', 'claude-opus-4-6'],
    ['claude-5-sonnet', 'claude-sonnet-5'],
    ['cursor/claude-4.6-opus-high', 'cursor/claude-opus-4.6-high'],
    ['cursor-claude-4.6-haiku', 'cursor-claude-haiku-4.6'],
  ])('moves the family in front of the version: %s', (model, expected) => {
    expect(familyFirst(model)).toBe(expected)
  })

  it('leaves a family-first name alone', () => {
    expect(familyFirst('claude-opus-4.6')).toBeNull()
    expect(familyFirst('anthropic/claude-sonnet-4-6-thinking')).toBeNull()
  })

  it('does not fire inside another word', () => {
    expect(familyFirst('myclaude-4-opus')).toBeNull()
    expect(familyFirst('claude-4-opusx')).toBeNull()
  })
})

describe('peelroutingtiers', () => {
  it('peels one tier per step, least peeled first', () => {
    expect(peelRoutingTiers('gpt-5-high')).toEqual(['gpt-5'])
    expect(peelRoutingTiers('antigravity/claude-opus-4-6-thinking')).toEqual(['antigravity/claude-opus-4-6'])
    expect(peelRoutingTiers('m-thinking-xhigh')).toEqual(['m-thinking', 'm'])
  })

  it('carries -fast through the peel instead of dropping it', () => {
    // `-fast` is a rate multiplier: the 6x card must come back, not the base.
    expect(peelRoutingTiers('claude-opus-4-7-high-fast')).toEqual(['claude-opus-4-7-fast'])
    expect(peelRoutingTiers('cursor/grok-4.6-xhigh-fast')).toEqual(['cursor/grok-4.6-fast'])
    expect(peelRoutingTiers('claude-opus-4-7-fast')).toEqual([])
  })

  it('leaves names that end in a model word alone', () => {
    expect(peelRoutingTiers('gpt-5.1-codex-max')).toEqual([])
    expect(peelRoutingTiers('qwen3-max')).toEqual([])
    expect(peelRoutingTiers('gemini-3.8-flash')).toEqual([])
    expect(peelRoutingTiers('gpt-5.1-codex-mini')).toEqual([])
  })

  it('never yields a form that names no model', () => {
    expect(peelRoutingTiers('high')).toEqual([])
    expect(peelRoutingTiers('gw/high')).toEqual([])
  })

  it('lowercases like the rest of the normalization', () => {
    expect(peelRoutingTiers('GPT-5-High')).toEqual(['gpt-5'])
  })
})

describe('pricingcandidates on a family-last spelling', () => {
  it('offers the family-first spelling in every form', () => {
    expect(has('cursor/claude-4.6-opus', 'claude-opus-4.6')).toBe(true)
    expect(has('cursor/claude-4.6-opus', 'claude-opus-4-6')).toBe(true)
    expect(has('claude-4-6-opus-20260101', 'claude-opus-4.6')).toBe(true)
  })

  it('keeps the literal ahead of the respelling', () => {
    const candidates = pricingCandidates('claude-3-5-sonnet')
    expect(candidates.indexOf('claude-3-5-sonnet')).toBeLessThan(candidates.indexOf('claude-sonnet-3-5'))
  })
})
