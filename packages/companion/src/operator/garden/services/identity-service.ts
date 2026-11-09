import { isRecord } from '../../../shared/utils/types.js';
import type { CharacterCardVersionStore } from '../../../core/identity/card-versioning.js';
import type { CharacterCardV2 } from '../../../core/identity/types.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { extractCardPatchFromRecord } from '../../../core/identity/card-versioning.js';
import { buildCharacterMacroMap } from '../../../core/identity/character-macro-map.js';
import type { PromptLayerStatePort } from '../../../core/identity/prompt-state-port.js';
import { syncCharacterFoundationPromptFromCard } from '../../../core/identity/prompt-sync.js';
import type {
  AdminIdentityData,
  AdminIdentityService,
  DiffPreviewResult,
  FieldUpdateResult,
  IntakeCommitResult,
  IntakeStageResult,
  OnboardingActionResult,
  RollbackResult,
} from './types.js';

type OnboardingEditableField =
  | 'name'
  | 'description'
  | 'personality'
  | 'scenario'
  | 'first_mes'
  | 'mes_example'
  | 'system_prompt'
  | 'post_history_instructions';

const ONBOARDING_EDITABLE_FIELDS: ReadonlySet<OnboardingEditableField> = new Set<OnboardingEditableField>([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
]);


function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function resolveMissingRequiredIdentityField(card: CharacterCardV2): 'name' | 'personality' | null {
  const macroMap = buildCharacterMacroMap(card);
  if (!macroMap.name?.trim()) return 'name';
  if (!macroMap.personality?.trim()) return 'personality';
  return null;
}

function isOnboardingRequired(card: CharacterCardV2): boolean {
  return card.data.creator === 'system' && normalizeTags(card.data.tags).includes('bootstrap');
}

function clearOnboardingMarker(card: CharacterCardV2): CharacterCardV2 {
  const normalizedTags = normalizeTags(card.data.tags).filter(tag => tag !== 'bootstrap');
  return {
    ...card,
    data: {
      ...card.data,
      tags: normalizedTags,
    },
  };
}

export class AdminIdentityDataService implements AdminIdentityService {
  constructor(private readonly deps: {
    characterCard: CharacterCardV2;
    config: SubstrateConfig;
    cardVersionStore?: CharacterCardVersionStore | null;
    promptStore: PromptLayerStatePort;
  }) {}

  private syncCharacterFoundationWithOutcome(
    card: CharacterCardV2,
    updatedBy: string,
    reason: string,
  ): { ok: true; warningSuffix: string } | { ok: false; error: string } {
    const promptSync = syncCharacterFoundationPromptFromCard(
      this.deps.promptStore,
      card,
      updatedBy,
      reason,
    );
    if (promptSync.ok) {
      return { ok: true, warningSuffix: '' };
    }
    if (promptSync.errorCode === 'missing_required_fields') {
      return {
        ok: false,
        error: promptSync.error ?? 'Missing required identity fields for Character Foundation sync',
      };
    }
    return {
      ok: true,
      warningSuffix: ` (Character Foundation sync warning: ${promptSync.error})`,
    };
  }

  private onboardingRequiredFromCurrent(): boolean {
    const current = this.deps.cardVersionStore?.getCurrent().card ?? this.deps.characterCard;
    return isOnboardingRequired(current);
  }

  private onboardingFailure(message: string): OnboardingActionResult {
    return {
      ok: false,
      message,
      onboardingRequired: this.onboardingRequiredFromCurrent(),
    };
  }

  getIdentityData(): AdminIdentityData {
    const snapshot = this.deps.cardVersionStore?.getCurrent();
    const history = this.deps.cardVersionStore?.getHistory() ?? [];
    const card = snapshot?.card ?? this.deps.characterCard;

    return {
      card,
      config: this.deps.config,
      version: snapshot?.version ?? 1,
      checksum: snapshot?.checksum,
      history,
      intakeReview: null,
    };
  }

  stageIdentityIntake(_body: string): IntakeStageResult {
    return {
      ok: false,
      message: 'Identity intake staging is not supported via JSON API yet',
    };
  }

  async commitIdentityIntake(_body: string): Promise<IntakeCommitResult> {
    return {
      ok: false,
      message: 'Identity intake commit is not supported via JSON API yet',
    };
  }

  rollbackIdentityCard(body: string): RollbackResult {
    const cardVersionStore = this.deps.cardVersionStore;
    if (!cardVersionStore) {
      return { ok: false, message: 'Card versioning store is not configured' };
    }

    let payload: { version?: number };
    try {
      payload = JSON.parse(body) as { version?: number };
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

    const version = Number(payload.version);
    if (!Number.isInteger(version) || version <= 0) {
      return { ok: false, message: 'version must be a positive integer' };
    }
    const targetEntry = cardVersionStore.getHistoryEntry(version);
    if (!targetEntry) {
      return { ok: false, message: `version ${version} is not available` };
    }
    const missingRequiredField = resolveMissingRequiredIdentityField(targetEntry.newCard);
    if (missingRequiredField) {
      return {
        ok: false,
        message: `Rollback blocked: required identity field "${missingRequiredField}" is empty in version ${version}`,
      };
    }

    try {
      const snapshot = cardVersionStore.rollback(version, 'admin:api');
      Object.assign(this.deps.characterCard, snapshot.card);
      const promptSyncOutcome = this.syncCharacterFoundationWithOutcome(
        snapshot.card,
        'admin:rollback',
        `Sync Character Foundation prompt after rollback to version ${version}`,
      );
      if (!promptSyncOutcome.ok) {
        return {
          ok: false,
          message: `Rollback failed: ${promptSyncOutcome.error}`,
        };
      }
      return {
        ok: true,
        message: `Rolled back to version ${version}${promptSyncOutcome.warningSuffix}`,
        snapshot,
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }
  }

  previewIdentityCardDiff(body: string): DiffPreviewResult {
    let payload: { version?: number };
    try {
      payload = JSON.parse(body) as { version?: number };
    } catch {
      return {
        ok: false,
        current: this.deps.characterCard,
        target: this.deps.characterCard,
      };
    }

    const cardVersionStore = this.deps.cardVersionStore;
    if (!cardVersionStore) {
      return {
        ok: false,
        current: this.deps.characterCard,
        target: this.deps.characterCard,
      };
    }

    const version = Number(payload.version);
    const entry = Number.isInteger(version) ? cardVersionStore.getHistoryEntry(version) : undefined;
    const current = cardVersionStore.getCurrent().card;
    return {
      ok: Boolean(entry),
      current,
      target: entry?.previousCard ?? current,
    };
  }

  updateIdentityField(body: string): FieldUpdateResult {
    const cardVersionStore = this.deps.cardVersionStore;
    if (!cardVersionStore) {
      return { ok: false, message: 'Card versioning store is not configured' };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

    const field = typeof payload.field === 'string' ? payload.field.trim() : '';
    const value = typeof payload.value === 'string' ? payload.value : '';

    if (!field) {
      return { ok: false, message: 'field is required' };
    }

    const patchRecord: Record<string, unknown> = {};
    if (field === 'alternate_greetings') {
      if (value.trim().length === 0) {
        patchRecord[field] = [];
      } else {
        try {
          const parsed = JSON.parse(value) as unknown;
          if (Array.isArray(parsed)) {
            patchRecord[field] = parsed;
          } else {
            patchRecord[field] = value;
          }
        } catch {
          patchRecord[field] = value;
        }
      }
    } else {
      patchRecord[field] = value;
    }

    const patch = extractCardPatchFromRecord(patchRecord);
    const nextCard: CharacterCardV2 = {
      ...this.deps.characterCard,
      data: {
        ...this.deps.characterCard.data,
        ...patch,
      },
    };
    const missingRequiredField = resolveMissingRequiredIdentityField(nextCard);
    if (missingRequiredField) {
      return {
        ok: false,
        message: `required identity field "${missingRequiredField}" cannot be empty`,
      };
    }
    try {
      const snapshot = cardVersionStore.updateData(patch, 'admin:api', `Admin edited field: ${field}`);
      // Also update the in-memory character card reference
      const current = snapshot.card;
      Object.assign(this.deps.characterCard, current);
      const promptSyncOutcome = this.syncCharacterFoundationWithOutcome(
        current,
        'admin:api',
        `Sync Character Foundation prompt after field update: ${field}`,
      );
      if (!promptSyncOutcome.ok) {
        return {
          ok: false,
          message: `Update failed: ${promptSyncOutcome.error}`,
        };
      }
      return {
        ok: true,
        message: `Updated "${field}" to v${snapshot.version}${promptSyncOutcome.warningSuffix}`,
      };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  }

  async applyOnboardingAction(body: string): Promise<OnboardingActionResult> {
    const cardVersionStore = this.deps.cardVersionStore;
    if (!cardVersionStore) {
      return this.onboardingFailure('Card versioning store is not configured');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      return this.onboardingFailure('Request body must be valid JSON');
    }

    if (!isRecord(payload)) {
      return this.onboardingFailure('Request body must be a JSON object');
    }

    const action = typeof payload.action === 'string' ? payload.action.trim() : '';
    if (action === 'keep_starter') {
      const extraKeys = Object.keys(payload).filter(key => key !== 'action');
      if (extraKeys.length > 0) {
        return this.onboardingFailure('keep_starter does not accept additional fields');
      }

      const current = cardVersionStore.getCurrent().card;
      const nextCard = clearOnboardingMarker(current);
      const snapshot = cardVersionStore.update(
        nextCard,
        'admin:onboarding',
        'Keep starter identity and complete onboarding',
      );
      Object.assign(this.deps.characterCard, snapshot.card);
      const promptSyncOutcome = this.syncCharacterFoundationWithOutcome(
        snapshot.card,
        'admin:onboarding',
        'Sync Character Foundation prompt after onboarding keep starter action',
      );
      if (!promptSyncOutcome.ok) {
        return {
          ok: false,
          message: `Onboarding failed: ${promptSyncOutcome.error}`,
          onboardingRequired: isOnboardingRequired(snapshot.card),
          action: 'keep_starter',
        };
      }
      return {
        ok: true,
        message: `Starter identity confirmed as v${snapshot.version}${promptSyncOutcome.warningSuffix}`,
        onboardingRequired: isOnboardingRequired(snapshot.card),
        action: 'keep_starter',
      };
    }

    if (action === 'edit_identity') {
      const extraKeys = Object.keys(payload).filter(key => key !== 'action' && key !== 'fields');
      if (extraKeys.length > 0) {
        return this.onboardingFailure('edit_identity only accepts action and fields');
      }

      if (!isRecord(payload.fields)) {
        return this.onboardingFailure('fields is required for edit_identity');
      }
      const fields = payload.fields as Record<string, unknown>;
      const fieldEntries = Object.entries(fields);
      if (fieldEntries.length === 0) {
        return this.onboardingFailure('fields must include at least one editable identity field');
      }

      const patchData: Partial<CharacterCardV2['data']> = {};
      const updatedFields: string[] = [];

      for (const [rawField, rawValue] of fieldEntries) {
        if (!ONBOARDING_EDITABLE_FIELDS.has(rawField as OnboardingEditableField)) {
          return this.onboardingFailure(`Unsupported onboarding identity field "${rawField}"`);
        }
        if (typeof rawValue !== 'string') {
          return this.onboardingFailure(`Field "${rawField}" must be a string`);
        }
        if ((rawField === 'name' || rawField === 'personality') && rawValue.trim().length === 0) {
          return this.onboardingFailure(`Field "${rawField}" cannot be empty`);
        }
        patchData[rawField as OnboardingEditableField] = rawValue;
        updatedFields.push(rawField);
      }

      if (updatedFields.length === 0) {
        return this.onboardingFailure('fields must include at least one editable identity field');
      }

      const current = cardVersionStore.getCurrent().card;
      const nextCard: CharacterCardV2 = clearOnboardingMarker({
        ...current,
        data: {
          ...current.data,
          ...patchData,
        },
      });

      const missingRequiredField = resolveMissingRequiredIdentityField(nextCard);
      if (missingRequiredField) {
        return this.onboardingFailure(`required identity field "${missingRequiredField}" cannot be empty`);
      }

      const snapshot = cardVersionStore.update(
        nextCard,
        'admin:onboarding',
        `Onboarding identity edit: ${updatedFields.join(', ')}`,
      );
      Object.assign(this.deps.characterCard, snapshot.card);

      const promptSyncOutcome = this.syncCharacterFoundationWithOutcome(
        snapshot.card,
        'admin:onboarding',
        'Sync Character Foundation prompt after onboarding identity edit',
      );
      if (!promptSyncOutcome.ok) {
        return {
          ok: false,
          message: `Onboarding failed: ${promptSyncOutcome.error}`,
          onboardingRequired: isOnboardingRequired(snapshot.card),
          action: 'edit_identity',
          updatedFields,
        };
      }

      return {
        ok: true,
        message: `Onboarding identity updated to v${snapshot.version}${promptSyncOutcome.warningSuffix}`,
        onboardingRequired: isOnboardingRequired(snapshot.card),
        action: 'edit_identity',
        updatedFields,
      };
    }

    return this.onboardingFailure('action must be one of: keep_starter, edit_identity');
  }
}
