/**
 * A complete standalone configuration for tests: every setting explicit,
 * synthetic operator identity, temporary storage roots, the database URL in a
 * named environment variable and no model key (the faux provider needs none).
 */
export const DATABASE_URL_ENV = 'LITE_TEST_DATABASE_URL';

export function liteConfigDocument(roots: { readonly history: string; readonly workspace: string; readonly backups: string | null }) {
  return {
    companionId: 'companion-test',
    surface: 'standalone',
    operator: {
      displayName: 'Robin',
      channelKind: 'cli',
      externalId: 'operator-1',
      channelId: 'cli-direct',
      trust: 'primary',
      relationship: 'partner',
      sensitivity: 'personal',
    },
    storage: { historyRoot: roots.history, workspaceRoot: roots.workspace, backupRoot: roots.backups },
    postgres: { urlEnv: DATABASE_URL_ENV },
    model: { provider: 'faux', modelId: 'faux-1', apiKeyEnv: null, maxOutputTokens: 1024 },
    embedding: { space: { name: 'test-space', dimensions: 3 }, provider: { kind: 'disabled' } },
    policies: { disclosure: 'baseline', emotion: 'baseline', freeTime: 'baseline' },
    approvals: { kind: 'refuse' },
    harness: { turnLeaseMs: 60_000, maxModelCalls: 4, maxToolResultChars: 4_000, historyEntries: 50, selfStateItems: 10 },
    workers: { leaseMs: 60_000, maxAttempts: 2, resumeGraceMs: 15 * 60_000 },
    scheduler: { tickIntervalMs: 60_000, inFlightMs: 10 * 60_000, maintenanceEveryTicks: 10, maintenanceSessionLimit: 10, maintenanceMaxEntries: 500 },
    memory: { endedAfterMs: 30 * 60_000 },
    mcp: null as Record<string, unknown> | null,
    lifecycle: null as Record<string, unknown> | null,
  };
}
