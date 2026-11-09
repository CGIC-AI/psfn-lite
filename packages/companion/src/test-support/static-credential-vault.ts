// Lite test fake of the CredentialVaultPort (shared/contracts/credential-contracts.ts).
//
// The donor tests built their vault fixtures with the gateway's
// createStaticCredentialVault / createEnvCredentialVault
// (boundary/custody/credential-vault.ts:94-119 at e6a9546). That custody module
// is gateway scaffolding and is deleted in Step B7; the tests only need a port
// that resolves names from a record, so this fake keeps exactly those
// semantics (the reference name is validated by envCredential, the value is
// normalised by normalizeCredentialValue, resolveRequired throws
// "<description> is not configured").
import {
  envCredential,
  normalizeCredentialValue,
  type CredentialVaultPort,
} from '../shared/contracts/credential-contracts.js';

export function createStaticCredentialVault(
  credentials: Readonly<Record<string, unknown>>,
): CredentialVaultPort {
  return {
    resolveOptional(reference) {
      const credentialName = envCredential(reference.envName).envName;
      return normalizeCredentialValue(credentials[credentialName]);
    },
    resolveRequired(reference, description) {
      const value = this.resolveOptional(reference);
      if (value) {
        return value;
      }
      throw new Error(`${description} is not configured`);
    },
    has(reference) {
      return this.resolveOptional(reference) !== undefined;
    },
  };
}

export function createEnvCredentialVault(
  env: NodeJS.ProcessEnv = process.env,
): CredentialVaultPort {
  return createStaticCredentialVault(env);
}
