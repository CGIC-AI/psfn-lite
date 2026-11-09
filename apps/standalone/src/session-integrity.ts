/**
 * Session journal integrity for the standalone host (docs/extraction.md,
 * Step E2). Every journal entry is signed with the donor HMAC chain
 * (createKeyringIntegrityProvider over a SessionHmacKeyring, seam 3.8).
 *
 * A Hermes install is one source serving one user (its desktop, gateway,
 * mobile, messaging and CLI surfaces), so its conversations are bound to the
 * install: the entries of a Hermes conversation (the donor channel
 * convention `api:hermes:<digest>`, externalMemorySessionId) are signed with
 * the env keyring scoped to the bound install. Each key version is replaced
 * by HMAC-SHA256(key, label + install id). The install id names the binding
 * and is not a secret; the keyring is the secret, so the scoped key cannot be
 * derived from the install id alone. A journal written for another install
 * fails verification. Every other conversation (the operator's own Pi turns,
 * the web connector) uses the env keyring as the donor did.
 */
import { createHmac } from 'node:crypto';
import { createKeyringIntegrityProvider, type JournalEntry, type SessionHmacKeyring, type SessionIntegrityProvider } from './companion.ts';

/** The donor channel prefix of a Hermes conversation (shared/contracts/external-memory.ts externalMemorySessionId). */
export const HERMES_CHANNEL_PREFIX = 'api:hermes:';
const SCOPE_LABEL = 'psfn-lite hermes-install session keyring v1\n';

/** The env keyring scoped to one Hermes install: the same key versions, each key derived from the secret key and the install id. */
export function scopeKeyringToHermesInstall(keyring: SessionHmacKeyring, hermesInstallId: string): SessionHmacKeyring {
  const keys = Object.fromEntries(Object.entries(keyring.keys).map(([version, key]) => [
    version,
    createHmac('sha256', key).update(SCOPE_LABEL + hermesInstallId, 'utf8').digest('hex'),
  ]));
  return { activeVersion: keyring.activeVersion, keys };
}

/**
 * The host's integrity provider: the donor keyring chain, with the bound
 * Hermes install's conversations on the scoped keyring. Without a bound
 * install every conversation uses the env keyring.
 */
export function createHostSessionIntegrityProvider(keyring: SessionHmacKeyring, hermesInstallId: string | null): SessionIntegrityProvider {
  const plain = createKeyringIntegrityProvider(keyring);
  if (plain === null) throw new Error('the session keyring has no keys');
  if (hermesInstallId === null) return plain;
  const scoped = createKeyringIntegrityProvider(scopeKeyringToHermesInstall(keyring, hermesInstallId));
  if (scoped === null) throw new Error('the scoped session keyring has no keys');
  const providerOf = (entry: JournalEntry) => (entry.channelId.startsWith(HERMES_CHANNEL_PREFIX) ? scoped : plain);
  return {
    sign: (entry, previousHmac) => providerOf(entry).sign(entry, previousHmac),
    verify: (entry, previousHmac) => providerOf(entry).verify(entry, previousHmac),
  };
}
