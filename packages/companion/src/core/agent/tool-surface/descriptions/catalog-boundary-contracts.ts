import { action, type CanonicalToolSurfaceContract } from './contracts.js';

export const CATALOG_BOUNDARY_TOOL_CONTRACTS = {
  tool_search: {
    purpose: 'Look up long-form documentation for a canonical tool by name, purpose, action, or parameter.',
    actions: [action('search', [], ['query', 'limit'], {
      id: 'search', actionField: false,
      rule: 'the callable schema has no action field and lookup never loads, activates, grants, or changes callability',
    })],
    output: 'It returns matching documentation for tools that are already present in the callable catalog.',
    guidance: 'Do not use it to perform a domain operation; call the documented canonical tool directly.',
    example: { query: 'publish a repository change' },
  },
  toolset: {
    purpose: 'Inspect the always-callable catalog, request advisory ranking, or manage presentation-order pins.',
    actions: [
      action('list'),
      action('suggest', ['intent'], ['limit']),
      action('describe', ['tool']),
      action('pin', ['tool'], ['reason']),
      action('unpin', ['tool'], ['reason']),
    ],
    output: 'Every registered tool is already callable without activation; it returns catalog or ordering state and never performs a domain operation or grants capability.',
    guidance: 'Do not search again after choosing a tool; call its canonical name directly.',
    example: { action: 'describe', tool: 'repo' },
  },
  response_control: {
    purpose: 'Record an intentional decision to send no outward response for the current turn.',
    actions: [action('no_reply', [], ['reason'])],
    output: 'It returns an audited disposition and never emits a sentinel visible to the person.',
    guidance: 'Do not use it while a generated paid attachment still needs an ordinary reply for delivery.',
    example: { action: 'no_reply', reason: 'The message requests no response.' },
  },
} as const satisfies Record<string, CanonicalToolSurfaceContract>;
