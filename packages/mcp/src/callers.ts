/**
 * The callers one MCP server recognizes: the operator's static bindings and,
 * where the host runs internal turns, the credentials minted for them. The
 * transports check `identify` before reading a request; core ingress is
 * built with `authenticator` and admits every call.
 */
import { denied, type CallerAuthenticatorPort, type HostAttestation, type Result } from './core.ts';

export interface McpCallers {
  /** A name for the caller a credential belongs to, or null. */
  identify(credential: string): string | null;
  readonly authenticator: CallerAuthenticatorPort;
}

/**
 * Recognizes a credential if any source does. Every source is asked on
 * every call, so the answer's timing does not say which source matched.
 * Only `unknown_authority` passes to the next source; any other failure is
 * returned as it is.
 */
export function combineCallers(...sources: readonly McpCallers[]): McpCallers {
  const all = [...sources];
  return {
    identify(credential) {
      const names = all.map((s) => s.identify(credential));
      return names.find((n) => n !== null) ?? null;
    },
    authenticator: {
      async authenticate(evidence): Promise<Result<HostAttestation>> {
        const results = await Promise.all(all.map((s) => s.authenticator.authenticate(evidence)));
        for (const result of results) {
          if (result.ok) return result;
          if (result.error.kind !== 'denied' || result.error.reason !== 'unknown_authority') return result;
        }
        return denied('unknown_authority', 'credential is not bound to a caller');
      },
    },
  };
}
