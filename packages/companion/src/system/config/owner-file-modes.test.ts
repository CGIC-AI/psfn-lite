import { describe, expect, it } from 'vitest';
import {
  canonicalOwnerFileMode,
  formatOwnerFileMode,
  OWNER_FILE_MODE_AUTH_ADJACENT,
  OWNER_FILE_MODE_COMPANION_POLICY,
  OWNER_FILE_MODE_FLEET_SHARED,
} from './owner-file-modes.js';

/** The value of donor system/config/fleet-auth-config.ts:47 FLEET_AUTH_FILE_NAME (that module is cut). */
const FLEET_AUTH_FILE_NAME = 'fleet-auth.json';

describe('canonicalOwnerFileMode', () => {
  it('derives sensitivity-specific modes from the owner-file registry', () => {
    expect(canonicalOwnerFileMode({ ownerFileName: FLEET_AUTH_FILE_NAME, scope: 'system' }))
      .toBe(OWNER_FILE_MODE_AUTH_ADJACENT);
    expect(canonicalOwnerFileMode({ ownerFileName: 'charge-policy.json', scope: 'companion' }))
      .toBe(OWNER_FILE_MODE_COMPANION_POLICY);
    expect(canonicalOwnerFileMode({ ownerFileName: 'settings.json', scope: 'system' }))
      .toBe(OWNER_FILE_MODE_FLEET_SHARED);
    expect(formatOwnerFileMode(OWNER_FILE_MODE_AUTH_ADJACENT)).toBe('600');
    expect(formatOwnerFileMode(OWNER_FILE_MODE_COMPANION_POLICY)).toBe('640');
    expect(formatOwnerFileMode(OWNER_FILE_MODE_FLEET_SHARED)).toBe('644');
  });
});
