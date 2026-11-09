/**
 * The standalone host's session integrity (docs/extraction.md, Step E2): the
 * donor HMAC chain over the env keyring, with a bound Hermes install's
 * conversations on a keyring scoped to that install.
 */
import { describe, expect, it } from 'vitest';
import { createHostSessionIntegrityProvider, scopeKeyringToHermesInstall } from '../../apps/standalone/src/session-integrity.ts';
import { createKeyringIntegrityProvider, type JournalEntry, type SessionHmacKeyring } from '../../apps/standalone/src/companion.ts';

const INSTALL_A = '0123456789abcdef0123456789abcdef';
const INSTALL_B = 'fedcba9876543210fedcba9876543210';
const KEYRING: SessionHmacKeyring = { activeVersion: 'v2', keys: { v1: 'k'.repeat(64), v2: 'q'.repeat(64) } };
const HERMES_CHANNEL = 'api:hermes:4c1d0f9e0e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829304';

function entry(channelId: string, id: number, content: string): JournalEntry {
  return { type: 'message', id, channelId, role: 'user', content, authorId: 'robin', authorName: 'Robin', timestamp: 1_700_000_000_000 + id };
}

/** Signs entries as the donor store appends them: each chained to the previous signature. */
function chain(sign: (e: JournalEntry, previous: string | null) => JournalEntry, entries: readonly JournalEntry[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const e of entries) out.push(sign(e, out.at(-1)?._hmac ?? null));
  return out;
}

describe('session integrity', () => {
  it('scopes every key version to the install, keeping the versions, and needs the secret key', () => {
    const scoped = scopeKeyringToHermesInstall(KEYRING, INSTALL_A);
    expect(scoped.activeVersion).toBe('v2');
    expect(Object.keys(scoped.keys).sort()).toEqual(['v1', 'v2']);
    expect(scoped).toEqual(scopeKeyringToHermesInstall(KEYRING, INSTALL_A));
    expect(scoped.keys['v2']).not.toBe(KEYRING.keys['v2']);
    expect(scoped.keys['v2']).not.toBe(scopeKeyringToHermesInstall(KEYRING, INSTALL_B).keys['v2']);
    // The install id alone does not give the key: another secret gives another scoped key.
    const other = { activeVersion: 'v2', keys: { v1: 'k'.repeat(64), v2: 'z'.repeat(64) } };
    expect(scopeKeyringToHermesInstall(other, INSTALL_A).keys['v2']).not.toBe(scoped.keys['v2']);
  });

  it('signs a Hermes conversation for the bound install only; tampering and another install are detected', () => {
    const bound = createHostSessionIntegrityProvider(KEYRING, INSTALL_A);
    const signed = chain(bound.sign, [entry(HERMES_CHANNEL, 1, 'hello'), entry(HERMES_CHANNEL, 2, 'again')]);
    expect(signed.every((e) => typeof e._hmac === 'string' && e._hmacKeyVersion === 'v2')).toBe(true);
    expect(bound.verify(signed[0]!, null).verified).toBe(true);
    expect(bound.verify(signed[1]!, signed[0]!._hmac!).verified).toBe(true);

    expect(bound.verify({ ...signed[1]!, content: 'edited' }, signed[0]!._hmac!)).toMatchObject({ verified: false, reason: 'signature_mismatch' });
    expect(bound.verify(signed[1]!, null).verified).toBe(false);
    const { _hmac: _dropped, ...unsigned } = signed[0]!;
    expect(bound.verify(unsigned, null)).toMatchObject({ verified: false, reason: 'missing_signature' });

    expect(createHostSessionIntegrityProvider(KEYRING, INSTALL_B).verify(signed[0]!, null)).toMatchObject({ verified: false, reason: 'signature_mismatch' });
    expect(createKeyringIntegrityProvider(KEYRING)!.verify(signed[0]!, null).verified).toBe(false);
  });

  it('keeps the donor env-keyring chain for every other conversation', () => {
    const donor = createKeyringIntegrityProvider(KEYRING)!;
    const own = chain(createHostSessionIntegrityProvider(KEYRING, INSTALL_A).sign, [entry('terminal:robin', 1, 'from the terminal')]);
    expect(donor.verify(own[0]!, null).verified).toBe(true);
    expect(createHostSessionIntegrityProvider(KEYRING, INSTALL_B).verify(own[0]!, null).verified).toBe(true);
    // With no bound install the host's provider is the donor's.
    const hermes = chain(donor.sign, [entry(HERMES_CHANNEL, 1, 'unbound')]);
    expect(createHostSessionIntegrityProvider(KEYRING, null).verify(hermes[0]!, null).verified).toBe(true);
  });
});
