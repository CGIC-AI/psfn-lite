/**
 * Test-only in-memory fakes of the durable identity, session and contact
 * ports. They implement the documented compare-and-set and uniqueness
 * contracts so behavior tests exercise real failure paths.
 */
import {
  conflict,
  fail,
  notFound,
  ok,
  type ArchiveHead,
  type ArchivedEntry,
  type ChannelIdentity,
  type ContactChange,
  type ContactId,
  type ContactNote,
  type ContactRecord,
  type ContactStorePort,
  type ContinuityArtifact,
  type ContinuityPort,
  type ConversationHead,
  type CoreBlock,
  type CoreBlockPort,
  type CoreBlockScope,
  CORE_BLOCK_LIMITS,
  CORE_BLOCK_NAMES,
  type FocusPort,
  type FocusRecord,
  type LayerType,
  type ModelPort,
  type NorthStarItem,
  type NorthStarPort,
  type NorthStarState,
  type PersonaPort,
  type PersonaVersion,
  type PromptLayer,
  type PromptLayerPort,
  type PromptLayerVersion,
  type Result,
  type SessionCatalogPort,
  type SessionCursor,
  type SessionId,
  type SessionRecord,
  type TranscriptHit,
  type TranscriptProjectionPort,
  type ApprovalPort,
  type ValueEntry,
  type ValuesJournalPort,
} from '../../packages/core/src/index.ts';

export class FakeSessionCatalog implements SessionCatalogPort {
  readonly sessions = new Map<SessionId, SessionRecord>();
  readonly heads = new Map<string, ConversationHead>();

  get(sessionId: SessionId): Promise<Result<SessionRecord>> {
    const found = this.sessions.get(sessionId);
    return Promise.resolve(found === undefined ? notFound(`session ${sessionId}`) : ok(found));
  }
  create(record: SessionRecord): Promise<Result<SessionRecord>> {
    if (this.sessions.has(record.sessionId)) return Promise.resolve(conflict('already_exists', 'session exists'));
    this.sessions.set(record.sessionId, record);
    return Promise.resolve(ok(record));
  }
  touch(sessionId: SessionId, at: string): Promise<Result<void>> {
    const found = this.sessions.get(sessionId);
    if (found === undefined) return Promise.resolve(notFound(`session ${sessionId}`));
    if (at > found.lastActivityAt) this.sessions.set(sessionId, { ...found, lastActivityAt: at });
    return Promise.resolve(ok(undefined));
  }
  list(limit: number, cursor: SessionCursor | null): Promise<Result<readonly SessionRecord[]>> {
    const sorted = [...this.sessions.values()].sort((a, b) =>
      a.lastActivityAt === b.lastActivityAt ? (a.sessionId < b.sessionId ? 1 : -1) : a.lastActivityAt < b.lastActivityAt ? 1 : -1,
    );
    const start =
      cursor === null
        ? 0
        : sorted.findIndex((s) => s.lastActivityAt < cursor.lastActivityAt || (s.lastActivityAt === cursor.lastActivityAt && s.sessionId < cursor.sessionId));
    return Promise.resolve(ok(start === -1 ? [] : sorted.slice(start, start + limit)));
  }
  active(conversation: string): Promise<Result<ConversationHead | null>> {
    return Promise.resolve(ok(this.heads.get(conversation) ?? null));
  }
  setActive(conversation: string, sessionId: SessionId, expectedRevision: number): Promise<Result<ConversationHead>> {
    const current = this.heads.get(conversation);
    if ((current?.revision ?? 0) !== expectedRevision) return Promise.resolve(conflict('stale_revision', 'head moved'));
    const head = { conversation, sessionId, revision: expectedRevision + 1 };
    this.heads.set(conversation, head);
    return Promise.resolve(ok(head));
  }
}

export class FakeContinuity implements ContinuityPort {
  readonly artifacts: ContinuityArtifact[] = [];
  append(artifact: ContinuityArtifact): Promise<Result<ContinuityArtifact>> {
    this.artifacts.push(artifact);
    return Promise.resolve(ok(artifact));
  }
  list(sessionIds: readonly SessionId[], limit: number): Promise<Result<readonly ContinuityArtifact[]>> {
    return Promise.resolve(ok(this.artifacts.filter((a) => sessionIds.includes(a.sessionId)).slice(-limit).reverse()));
  }
}

export class FakeFocus implements FocusPort {
  readonly records = new Map<string, FocusRecord>();
  open(record: FocusRecord): Promise<Result<FocusRecord>> {
    if ([...this.records.values()].some((r) => r.sessionId === record.sessionId && r.completion === null)) {
      return Promise.resolve(conflict('already_exists', 'focus already open'));
    }
    this.records.set(record.focusId, record);
    return Promise.resolve(ok(record));
  }
  openFor(sessionId: SessionId): Promise<Result<FocusRecord | null>> {
    return Promise.resolve(ok([...this.records.values()].find((r) => r.sessionId === sessionId && r.completion === null) ?? null));
  }
  complete(focusId: string, completion: NonNullable<FocusRecord['completion']>): Promise<Result<FocusRecord>> {
    const found = this.records.get(focusId);
    if (found?.completion !== null) return Promise.resolve(found === undefined ? notFound(`focus ${focusId}`) : conflict('stale_revision', 'focus closed'));
    const done = { ...found, completion };
    this.records.set(focusId, done);
    return Promise.resolve(ok(done));
  }
}

export class FakeProjection implements TranscriptProjectionPort {
  readonly rows = new Map<SessionId, ArchivedEntry[]>();
  watermark(sessionId: SessionId): Promise<Result<ArchiveHead>> {
    const rows = this.rows.get(sessionId) ?? [];
    return Promise.resolve(ok({ sessionId, count: rows.length, hash: rows.at(-1)?.hash ?? null }));
  }
  project(sessionId: SessionId, entries: readonly ArchivedEntry[], expected: ArchiveHead): Promise<Result<ArchiveHead>> {
    const rows = this.rows.get(sessionId) ?? [];
    if (rows.length !== expected.count) return Promise.resolve(conflict('stale_revision', 'watermark moved'));
    const next = [...rows, ...entries];
    this.rows.set(sessionId, next);
    return Promise.resolve(ok({ sessionId, count: next.length, hash: next.at(-1)?.hash ?? null }));
  }
  reset(sessionId: SessionId): Promise<Result<void>> {
    this.rows.delete(sessionId);
    return Promise.resolve(ok(undefined));
  }
  search(query: string, sessionIds: readonly SessionId[], limit: number): Promise<Result<readonly TranscriptHit[]>> {
    const tokens = query.toLowerCase().split(/\s+/);
    const hits = sessionIds
      .flatMap((id) => this.rows.get(id) ?? [])
      .filter((row) => tokens.every((t) => row.entry.text.toLowerCase().includes(t)))
      .map((row) => ({ seq: row.seq, entry: row.entry, rank: 1 }));
    return Promise.resolve(ok(hits.slice(0, limit)));
  }
}

export class FakeModel implements ModelPort {
  readonly calls: Parameters<ModelPort['complete']>[0][] = [];
  reply = 'machine summary';
  complete(request: Parameters<ModelPort['complete']>[0]): ReturnType<ModelPort['complete']> {
    this.calls.push(request);
    return Promise.resolve(ok({ text: this.reply, inputTokens: 1, outputTokens: 1 }));
  }
}

export class FakeApprovals implements ApprovalPort {
  readonly submitted: Parameters<ApprovalPort['submit']>[0][] = [];
  submit(proposal: Parameters<ApprovalPort['submit']>[0]): ReturnType<ApprovalPort['submit']> {
    this.submitted.push(proposal);
    return Promise.resolve(ok({ proposalId: `proposal-${this.submitted.length}` }));
  }
}

export class FakeContactStore implements ContactStorePort {
  readonly records = new Map<ContactId, ContactRecord>();
  readonly changes: ContactChange[] = [];
  readonly noteRows: ContactNote[] = [];

  get(contactId: ContactId): Promise<Result<ContactRecord>> {
    const found = this.records.get(contactId);
    return Promise.resolve(found === undefined ? notFound(`contact ${contactId}`) : ok(found));
  }
  findByIdentity(identity: ChannelIdentity): Promise<Result<ContactRecord | null>> {
    const found = [...this.records.values()].find((r) =>
      r.identities.some((i) => i.channelKind === identity.channelKind && i.externalId === identity.externalId),
    );
    return Promise.resolve(ok(found ?? null));
  }
  list(limit: number, afterContactId: ContactId | null): Promise<Result<readonly ContactRecord[]>> {
    const sorted = [...this.records.values()].sort((a, b) => (a.contactId < b.contactId ? -1 : 1));
    return Promise.resolve(ok(sorted.filter((r) => afterContactId === null || r.contactId > afterContactId).slice(0, limit)));
  }
  create(record: ContactRecord, change: ContactChange): Promise<Result<ContactRecord>> {
    if (this.records.has(record.contactId)) return Promise.resolve(conflict('already_exists', 'contact exists'));
    const clash = this.identityClash(record);
    if (clash !== null) return Promise.resolve(clash);
    this.records.set(record.contactId, record);
    this.changes.push(change);
    return Promise.resolve(ok(record));
  }
  save(record: ContactRecord, expectedRevision: number, change: ContactChange): Promise<Result<ContactRecord>> {
    const current = this.records.get(record.contactId);
    if (current === undefined) return Promise.resolve(notFound(`contact ${record.contactId}`));
    if (current.revision !== expectedRevision) {
      return Promise.resolve(conflict('stale_revision', 'contact moved', { expectedRevision, actualRevision: current.revision }));
    }
    const clash = this.identityClash(record);
    if (clash !== null) return Promise.resolve(clash);
    this.records.set(record.contactId, record);
    this.changes.push(change);
    return Promise.resolve(ok(record));
  }
  merge(
    source: ContactRecord,
    survivor: ContactRecord,
    expected: { readonly source: number; readonly survivor: number },
    change: ContactChange,
  ): Promise<Result<{ readonly source: ContactRecord; readonly survivor: ContactRecord }>> {
    if (this.records.get(source.contactId)?.revision !== expected.source || this.records.get(survivor.contactId)?.revision !== expected.survivor) {
      return Promise.resolve(conflict('stale_revision', 'contact moved'));
    }
    this.records.set(source.contactId, source);
    this.records.set(survivor.contactId, survivor);
    this.changes.push(change);
    return Promise.resolve(ok({ source, survivor }));
  }
  appendNote(note: ContactNote): Promise<Result<ContactNote>> {
    this.noteRows.push(note);
    return Promise.resolve(ok(note));
  }
  notes(contactId: ContactId, limit: number): Promise<Result<readonly ContactNote[]>> {
    return Promise.resolve(ok(this.noteRows.filter((n) => n.contactId === contactId).slice(-limit).reverse()));
  }
  private identityClash(record: ContactRecord): Result<never> | null {
    for (const other of this.records.values()) {
      if (other.contactId === record.contactId) continue;
      for (const link of record.identities) {
        if (other.identities.some((i) => i.channelKind === link.channelKind && i.externalId === link.externalId)) {
          return conflict('identity_conflict', `${link.channelKind}:${link.externalId} belongs to ${other.contactId}`);
        }
      }
    }
    return null;
  }
}

export class FakeCoreBlocks implements CoreBlockPort {
  readonly blocks = new Map<string, CoreBlock>();
  read(scope: CoreBlockScope): Promise<Result<readonly CoreBlock[]>> {
    return Promise.resolve(ok(CORE_BLOCK_NAMES.map((name) => this.blocks.get(`${scope.channelId}/${name}`) ?? empty(scope, name))));
  }
  write(input: Parameters<CoreBlockPort['write']>[0]): Promise<Result<readonly CoreBlock[]>> {
    for (const change of input.changes) {
      const current = this.blocks.get(`${input.scope.channelId}/${change.name}`);
      if ((current?.revision ?? 0) !== change.expectedRevision) return Promise.resolve(conflict('stale_revision', `${change.name} moved`));
    }
    for (const change of input.changes) {
      const key = `${input.scope.channelId}/${change.name}`;
      const current = this.blocks.get(key) ?? empty(input.scope, change.name);
      this.blocks.set(key, { ...current, text: change.text, revision: current.revision + 1, author: input.author, updatedAt: input.at });
    }
    return this.read(input.scope);
  }
}

function empty(scope: CoreBlockScope, name: (typeof CORE_BLOCK_NAMES)[number]): CoreBlock {
  return { name, scope, text: '', maxChars: CORE_BLOCK_LIMITS[name], revision: 0, author: null, updatedAt: null };
}

export class FakeLayers implements PromptLayerPort {
  readonly meta = new Map<string, { name: string; type: LayerType }>();
  readonly versions = new Map<string, PromptLayerVersion[]>();
  list(): Promise<Result<readonly PromptLayer[]>> {
    return Promise.resolve(ok([...this.meta.keys()].map((id) => this.layer(id))));
  }
  get(layerId: string): Promise<Result<PromptLayer>> {
    return Promise.resolve(this.meta.has(layerId) ? ok(this.layer(layerId)) : notFound(`layer ${layerId}`));
  }
  history(layerId: string, limit: number): Promise<Result<readonly PromptLayerVersion[]>> {
    return Promise.resolve(ok([...(this.versions.get(layerId) ?? [])].reverse().slice(0, limit)));
  }
  version(layerId: string, version: number): Promise<Result<PromptLayerVersion>> {
    const found = this.versions.get(layerId)?.find((v) => v.version === version);
    return Promise.resolve(found === undefined ? notFound(`layer ${layerId} v${version}`) : ok(found));
  }
  commit(next: PromptLayerVersion, expectedVersion: number, create?: { readonly name: string; readonly type: LayerType }): Promise<Result<PromptLayer>> {
    const versions = this.versions.get(next.layerId) ?? [];
    if (versions.length !== expectedVersion || next.version !== expectedVersion + 1) return Promise.resolve(conflict('stale_revision', 'layer moved'));
    if (expectedVersion === 0) {
      if (create === undefined) return Promise.resolve(notFound(`layer ${next.layerId}`));
      this.meta.set(next.layerId, create);
    }
    this.versions.set(next.layerId, [...versions, next]);
    return Promise.resolve(ok(this.layer(next.layerId)));
  }
  private layer(id: string): PromptLayer {
    const meta = this.meta.get(id);
    const last = this.versions.get(id)?.at(-1);
    if (meta === undefined || last === undefined) throw new Error(`layer ${id} missing`);
    return { id, name: meta.name, type: meta.type, version: last.version, checksum: last.checksum, enabled: last.enabled, content: last.content };
  }
}

export class FakePersona implements PersonaPort {
  readonly versions: PersonaVersion[] = [];
  current(): Promise<Result<PersonaVersion | null>> {
    return Promise.resolve(ok(this.versions.at(-1) ?? null));
  }
  commit(next: PersonaVersion, expectedVersion: number): Promise<Result<PersonaVersion>> {
    if ((this.versions.at(-1)?.version ?? 0) !== expectedVersion) return Promise.resolve(conflict('stale_revision', 'persona moved'));
    this.versions.push(next);
    return Promise.resolve(ok(next));
  }
}

export class FakeValues implements ValuesJournalPort {
  readonly entries: ValueEntry[] = [];
  list(limit: number): Promise<Result<readonly ValueEntry[]>> {
    return Promise.resolve(ok([...this.entries].reverse().slice(0, limit)));
  }
  get(version: number): Promise<Result<ValueEntry>> {
    const found = this.entries.find((e) => e.version === version);
    return Promise.resolve(found === undefined ? notFound(`value v${version}`) : ok(found));
  }
  latestVersion(): Promise<Result<number>> {
    return Promise.resolve(ok(this.entries.at(-1)?.version ?? 0));
  }
  append(entry: ValueEntry): Promise<Result<ValueEntry>> {
    if (this.entries.some((e) => e.version === entry.version)) return Promise.resolve(conflict('already_exists', 'version exists'));
    this.entries.push(entry);
    return Promise.resolve(ok(entry));
  }
}

export class FakeNorthStar implements NorthStarPort {
  state: NorthStarState = { items: [], revision: 0 };
  readonly history: NorthStarItem[][] = [];
  read(): Promise<Result<NorthStarState>> {
    return Promise.resolve(ok(this.state));
  }
  save(items: readonly NorthStarItem[], expectedRevision: number): Promise<Result<NorthStarState>> {
    if (this.state.revision !== expectedRevision) return Promise.resolve(fail({ kind: 'conflict', reason: 'stale_revision', detail: 'moved' }));
    this.history.push([...items]);
    this.state = { items, revision: expectedRevision + 1 };
    return Promise.resolve(ok(this.state));
  }
}
