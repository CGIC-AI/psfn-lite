/**
 * The light Garden's eight screens (docs/extraction.md, seam S8). v1 reads
 * every screen and makes the core writes: memory delete, restore and redact;
 * a decision on a companion's deletion proposal; persona card fields and
 * prompt layers, with rollback; relationship proposals; concern resolve and
 * transition; and the capability tier and scheduler owner files, which
 * answer restart-needed (decision b).
 */
import { useState } from 'react';
import {
  CARD_FIELDS,
  CONCERN_STATUSES,
  TIERS,
  path,
  type Automata,
  type BiographicalClaim,
  type CardField,
  type Concern,
  type Constitution,
  type Contact,
  type Deleted,
  type DeletionProposal,
  type Emotion,
  type FocusSnapshot,
  type Garden,
  type GraphProposal,
  type HistoryEntry,
  type Identity,
  type InnerLife,
  type LayerDetail,
  type Memory,
  type MemoryDeletions,
  type MemoryDetail,
  type MemoryPage,
  type MemorySearch,
  type NorthStar,
  type Overview,
  type PromptLayer,
  type Prompts,
  type SessionList,
  type SessionMessages,
  type Settings,
  type SettingsSaved,
  type Turn,
  type TurnDetail,
} from './api.ts';
import { LayerDiffView } from './directives.tsx';
import { Card, Empty, Facts, Failure, Muted, Page, RestartNeeded, Section, Show, clip, useLoad, useWrite, when, type ScreenKey } from './ui.tsx';

export interface PaneToggle {
  readonly shown: boolean;
  readonly toggle: () => void;
}

export function GardenScreen({ garden, screen, pane }: { garden: Garden; screen: ScreenKey; pane?: PaneToggle }) {
  return (
    <Page garden={garden} screen={screen}>
      {screen === 'overview' && <OverviewScreen garden={garden} />}
      {screen === 'memories' && <MemoriesScreen garden={garden} pane={pane} />}
      {screen === 'persona' && <PersonaScreen garden={garden} />}
      {screen === 'people' && <PeopleScreen garden={garden} />}
      {screen === 'sessions' && <SessionsScreen garden={garden} />}
      {screen === 'inner-life' && <InnerLifeScreen garden={garden} />}
      {screen === 'automata' && <AutomataScreen garden={garden} />}
      {screen === 'settings' && <SettingsScreen garden={garden} />}
    </Page>
  );
}

const pad = (n: number) => n.toFixed(2);

function TurnList({ turns }: { turns: readonly Turn[] }) {
  if (turns.length === 0) return <Empty what="turns" />;
  return (
    <>
      {turns.map((turn, index) => (
        <Card key={`${turn.timestamp}-${index}`}>
          <Muted>{turn.authorName ?? turn.role} · {when(turn.timestamp)}</Muted>
          <div style={{ whiteSpace: 'pre-wrap' }}>{clip(turn.content)}</div>
        </Card>
      ))}
    </>
  );
}

function EmotionFacts({ emotion }: { emotion: Emotion | null }) {
  if (emotion === null) return <Empty what="emotion state" />;
  return (
    <Facts rows={[
      ['Now', `valence ${pad(emotion.vad.valence)}, arousal ${pad(emotion.vad.arousal)}, dominance ${pad(emotion.vad.dominance)}`],
      ['Mood', `valence ${pad(emotion.mood.valence)}, arousal ${pad(emotion.mood.arousal)}, dominance ${pad(emotion.mood.dominance)}`],
      ['Feeling', Object.entries(emotion.discrete).map(([name, value]) => `${name} ${pad(value)}`).join(', ') || '—'],
      ['Confidence', pad(emotion.confidence)],
    ]} />
  );
}

function FocusList({ focus }: { focus: readonly FocusSnapshot[] }) {
  if (focus.length === 0) return <Empty what="focus sessions" />;
  return <ul>{focus.map((f) => <li key={f.focusId}>{f.scope} <Muted>· since {when(f.startedAt)}</Muted></li>)}</ul>;
}

function OverviewScreen({ garden }: { garden: Garden }) {
  const overview = useLoad<Overview>(garden.rest, path.overview);
  return (
    <Show loaded={overview}>
      {(o) => (
        <>
          {o.restartRequired && <RestartNeeded />}
          <Facts rows={[
            ['Companion', o.companionId],
            ['Model', `${o.model.provider} / ${o.model.modelId}`],
            ['Capability tier', o.tier.tier],
            ['Latest session', o.latestSession === null ? '—' : `${o.latestSession.messageCount} messages, ${when(o.latestSession.lastActivityAt)}`],
          ]} />
          <Section title="Open concerns">
            {o.openConcerns.length === 0 ? <Empty what="open concerns" /> : <ul>{o.openConcerns.map((c) => <li key={c.id}>{c.text} <Muted>· {c.priority}</Muted></li>)}</ul>}
          </Section>
          <Section title="Focus"><FocusList focus={o.focus} /></Section>
          <Section title="Emotion"><EmotionFacts emotion={o.emotion} /></Section>
          <Section title="Heartbeat">
            {o.heartbeat.tasks.length === 0 ? <Empty what="scheduled tasks" /> : (
              <ul>{o.heartbeat.tasks.map((task) => <li key={task.id}>{task.name} <Muted>· {task.state}{task.lastOutcome === undefined ? '' : ` · last ${task.lastOutcome}`}</Muted></li>)}</ul>
            )}
          </Section>
          <Section title="Recent turns"><TurnList turns={o.recentTurns} /></Section>
        </>
      )}
    </Show>
  );
}

function MemoryFacts({ memory }: { memory: Memory }) {
  return <Muted>{memory.type} · {memory.sensitivity} · importance {memory.importance} · {when(memory.extractedAt)}</Muted>;
}

/** One memory: its detail on request, and the redact, delete and restore writes. */
function MemoryRow({ garden, memory, onChanged, onDeleted }: { garden: Garden; memory: Memory; onChanged: () => void; onDeleted: (deleted: Deleted) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<null | 'delete' | 'redact'>(null);
  const [text, setText] = useState(memory.text);
  const [reason, setReason] = useState('');
  const detail = useLoad<MemoryDetail>(garden.rest, open ? path.memory(memory.id) : null);
  const write = useWrite(garden.rest);
  const why = reason.trim();
  const close = () => {
    setEditing(null);
    setReason('');
  };
  return (
    <Card label={`memory ${memory.id}`}>
      <div style={{ whiteSpace: 'pre-wrap' }}>{memory.text}</div>
      <MemoryFacts memory={memory} />
      <Failure error={write.error} />
      {open && (
        <Show loaded={detail}>
          {({ memory: full }) => (
            <Facts rows={[
              ['Id', full.id],
              ['Source', full.sourceType ?? '—'],
              ['Written by', full.provenance?.toolName ?? '—'],
              ['Confidence', full.confidence === undefined ? '—' : pad(full.confidence)],
              ['Tags', [...(full.tags ?? []), ...(full.scopeTags ?? [])].join(', ') || '—'],
            ]} />
          )}
        </Show>
      )}
      {editing === 'redact' && (
        <div>
          <textarea aria-label="Redacted text" rows={3} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)} />
          <input aria-label="Reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />{' '}
          <button type="button" disabled={write.busy || why === '' || text.trim() === ''}
            onClick={() => write.run(path.patchMemory(memory.id), { method: 'PATCH', body: { text, reason: why } }, () => { close(); onChanged(); })}>Save redaction</button>{' '}
          <button type="button" onClick={close}>Cancel</button>
        </div>
      )}
      {editing === 'delete' && (
        <div>
          <input aria-label="Reason" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />{' '}
          <button type="button" disabled={write.busy} onClick={() => write.run<Deleted>(path.deleteMemory(memory.id), { method: 'POST', body: why === '' ? {} : { reason: why } }, onDeleted)}>Delete</button>{' '}
          <button type="button" onClick={close}>Cancel</button>
        </div>
      )}
      {editing === null && (
        <div>
          <button type="button" onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}</button>{' '}
          <button type="button" onClick={() => { setText(memory.text); setEditing('redact'); }}>Redact…</button>{' '}
          <button type="button" onClick={() => setEditing('delete')}>Delete…</button>
        </div>
      )}
    </Card>
  );
}

export function DeletionProposals({ garden }: { garden: Garden }) {
  const deletions = useLoad<MemoryDeletions>(garden.rest, path.memoryDeletions);
  const write = useWrite(garden.rest);
  const decide = (proposal: DeletionProposal, decision: 'approve' | 'reject') =>
    write.run(path.decideDeletion(proposal.id, decision), { method: 'POST' }, deletions.reload);
  const restore = (deleteId: string) => write.run(path.restoreMemory, { method: 'POST', body: { deleteId } }, deletions.reload);
  return (
    <Show loaded={deletions}>
      {(d) => (
        <>
          <Failure error={write.error} />
          {d.pending.length === 0 ? <Empty what="deletions waiting for a decision" /> : d.pending.map((proposal) => (
            <Card key={proposal.id} label={`proposal ${proposal.id}`}>
              <div>{proposal.explanation}</div>
              <Muted>{proposal.justificationCategory} · {proposal.status} · {when(proposal.proposedAt)}</Muted>
              {proposal.awaitingHostTurn === true ? (
                <p><Muted>The Hermes turn that asked for this is still deciding it.</Muted></p>
              ) : (
                <div>
                  <button type="button" disabled={write.busy} onClick={() => decide(proposal, 'approve')}>Approve deletion</button>{' '}
                  <button type="button" disabled={write.busy} onClick={() => decide(proposal, 'reject')}>Keep the memory</button>
                </div>
              )}
            </Card>
          ))}
          {d.recoverable.length > 0 && (
            <Section title="Recoverable">
              {d.recoverable.map((proposal) => (
                <Card key={proposal.id} label={`recoverable ${proposal.id}`}>
                  <div>{proposal.explanation}</div>
                  {proposal.deleteId !== undefined && (
                    <button type="button" disabled={write.busy} onClick={() => restore(proposal.deleteId as string)}>Restore</button>
                  )}
                </Card>
              ))}
            </Section>
          )}
        </>
      )}
    </Show>
  );
}

function MemoriesScreen({ garden, pane }: { garden: Garden; pane: PaneToggle | undefined }) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [lastDeleted, setLastDeleted] = useState<Deleted | null>(null);
  const page = useLoad<MemoryPage>(garden.rest, query === '' ? path.memories : null);
  const search = useLoad<MemorySearch>(garden.rest, query === '' ? null : path.memorySearch(query));
  const write = useWrite(garden.rest);
  const reload = () => (query === '' ? page.reload() : search.reload());
  const deleted = (answer: Deleted) => {
    setLastDeleted(answer);
    reload();
  };
  const restore = (deleteId: string) => write.run(path.restoreMemory, { method: 'POST', body: { deleteId } }, () => {
    setLastDeleted(null);
    reload();
  });
  const list = (memories: readonly Memory[]) => memories.length === 0 ? <Empty what="memories" /> : memories.map((memory) => (
    <MemoryRow key={memory.id} garden={garden} memory={memory} onChanged={reload} onDeleted={deleted} />
  ));
  return (
    <>
      <form onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); }}>
        <input aria-label="Search memories" placeholder="Search memories" value={draft} onChange={(e) => setDraft(e.target.value)} />{' '}
        <button type="submit">Search</button>{' '}
        {query !== '' && <button type="button" onClick={() => { setDraft(''); setQuery(''); }}>Show all</button>}
      </form>
      <Failure error={write.error} />
      {lastDeleted !== null && (
        <p role="status">Memory deleted. <button type="button" disabled={write.busy} onClick={() => restore(lastDeleted.deleteId)}>Undo</button></p>
      )}
      <Section title={query === '' ? 'Memories' : `Matching “${query}”`}>
        {query === '' ? (
          <Show loaded={page}>
            {(p) => (
              <>
                <p><Muted>{p.pagination.total} memories{p.withheldBySubjectAuthorizationCount === undefined || p.withheldBySubjectAuthorizationCount === 0 ? '' : `, ${p.withheldBySubjectAuthorizationCount} withheld`}</Muted></p>
                {list(p.memories)}
              </>
            )}
          </Show>
        ) : (
          <Show loaded={search}>{(s) => list(s.results)}</Show>
        )}
      </Section>
      <Section title="Deletions the companion asked for">
        {pane !== undefined && (
          <p><button type="button" onClick={pane.toggle}>{pane.shown ? 'Hide the side pane' : 'Show beside the chat'}</button></p>
        )}
        <DeletionProposals garden={garden} />
      </Section>
    </>
  );
}

function History({ entries, onRollback, busy }: { entries: readonly HistoryEntry[]; onRollback: (version: number) => void; busy: boolean }) {
  if (entries.length === 0) return <Empty what="earlier versions" />;
  return (
    <ul>
      {entries.map((entry) => (
        <li key={entry.version}>
          v{entry.version} <Muted>· {entry.timestamp} · {entry.updatedBy}{entry.reason === undefined ? '' : ` · ${entry.reason}`}</Muted>{' '}
          <button type="button" disabled={busy} onClick={() => onRollback(entry.version)}>Roll back to v{entry.version}</button>
        </li>
      ))}
    </ul>
  );
}

function LayerRow({ garden, layer, canWrite, onChanged }: { garden: Garden; layer: PromptLayer; canWrite: boolean; onChanged: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [view, setView] = useState<null | 'diff' | 'history'>(null);
  const detail = useLoad<LayerDetail>(garden.rest, view === 'history' ? path.layer(layer.id) : null);
  const write = useWrite(garden.rest);
  const editable = layer.type !== 'operator' || canWrite;
  const changed = () => {
    setContent(null);
    detail.reload();
    onChanged();
  };
  return (
    <Card label={`layer ${layer.id}`}>
      <strong>{layer.name}</strong> <Muted>{layer.identifier} · v{layer.version} · {layer.enabled ? 'on' : 'off'} · {layer.updatedAt}</Muted>
      <Failure error={write.error} />
      {content === null ? (
        <div>
          {editable && <button type="button" onClick={() => setContent(layer.content)}>Edit</button>}{' '}
          <button type="button" onClick={() => setView(view === 'diff' ? null : 'diff')}>{view === 'diff' ? 'Hide change' : 'Last change'}</button>{' '}
          <button type="button" onClick={() => setView(view === 'history' ? null : 'history')}>{view === 'history' ? 'Hide history' : 'History'}</button>
        </div>
      ) : (
        <div>
          <textarea aria-label={`${layer.name} content`} rows={8} style={{ width: '100%' }} value={content} onChange={(e) => setContent(e.target.value)} />
          <button type="button" disabled={write.busy} onClick={() => write.run(path.layer(layer.id), { method: 'PATCH', body: { content } }, changed)}>Save</button>{' '}
          <button type="button" onClick={() => setContent(null)}>Cancel</button>
        </div>
      )}
      {view === 'diff' && <LayerDiffView rest={garden.rest} layerId={layer.id} />}
      {view === 'history' && (
        <Show loaded={detail}>
          {(d) => <History entries={d.layerHistory ?? []} busy={write.busy || !editable} onRollback={(version) => write.run(path.layerRollback(layer.id), { method: 'POST', body: { version } }, changed)} />}
        </Show>
      )}
    </Card>
  );
}

function PersonaScreen({ garden }: { garden: Garden }) {
  const identity = useLoad<Identity>(garden.rest, path.identity);
  const prompts = useLoad<Prompts>(garden.rest, path.prompts);
  const constitution = useLoad<Constitution>(garden.rest, path.constitution);
  const northStar = useLoad<NorthStar>(garden.rest, path.northStar);
  const write = useWrite(garden.rest);
  const [field, setField] = useState<{ name: CardField; value: string } | null>(null);
  return (
    <>
      <Failure error={write.error} />
      <Section title="Persona card">
        <Show loaded={identity}>
          {(i) => (
            <>
              <p><Muted>Version {i.version}</Muted></p>
              {CARD_FIELDS.map((name) => (
                <Card key={name} label={`card ${name}`}>
                  <Muted>{name}</Muted>
                  {field?.name === name ? (
                    <div>
                      <textarea aria-label={name} rows={4} style={{ width: '100%' }} value={field.value} onChange={(e) => setField({ name, value: e.target.value })} />
                      <button type="button" disabled={write.busy} onClick={() => write.run(path.identityField, { method: 'PATCH', body: { field: name, value: field.value } }, () => { setField(null); identity.reload(); })}>Save</button>{' '}
                      <button type="button" onClick={() => setField(null)}>Cancel</button>
                    </div>
                  ) : (
                    <>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{i.card.data[name] === '' ? <Muted>(empty)</Muted> : i.card.data[name]}</div>
                      <button type="button" onClick={() => setField({ name, value: i.card.data[name] })}>Edit</button>
                    </>
                  )}
                </Card>
              ))}
              <Section title="Card history">
                <History entries={i.history} busy={write.busy} onRollback={(version) => write.run(path.identityRollback, { method: 'POST', body: { version } }, identity.reload)} />
              </Section>
            </>
          )}
        </Show>
      </Section>
      <Section title="Prompt layers">
        <Show loaded={prompts}>
          {(p) => p.layers.length === 0 ? <Empty what="prompt layers" /> : (
            <>{p.layers.map((l) => <LayerRow key={l.id} garden={garden} layer={l} canWrite={p.canWriteOperatorLayers} onChanged={prompts.reload} />)}</>
          )}
        </Show>
      </Section>
      <Section title="Values">
        <Show loaded={constitution}>
          {(c) => c.companionLayer === null ? <Empty what="values the companion has derived yet" /> : (
            <Card label="values"><Muted>{c.companionLayer.title} (the companion writes this layer)</Muted><div style={{ whiteSpace: 'pre-wrap' }}>{c.companionLayer.content}</div></Card>
          )}
        </Show>
      </Section>
      <Section title="North star">
        <Show loaded={northStar}>
          {(n) => n.items.length === 0 ? <Empty what="north-star items" /> : n.items.map((item) => (
            <Card key={item.id} label={`north star ${item.id}`}>
              <strong>{item.title}</strong> <Muted>· {item.scope} · {item.enabled ? 'on' : 'off'}</Muted>
              <div style={{ whiteSpace: 'pre-wrap' }}>{item.content}</div>
            </Card>
          ))}
        </Show>
      </Section>
    </>
  );
}

function PeopleScreen({ garden }: { garden: Garden }) {
  const contacts = useLoad<{ contacts: Contact[] }>(garden.rest, path.contacts);
  const claims = useLoad<{ claims: BiographicalClaim[] }>(garden.rest, path.claims);
  const proposals = useLoad<{ proposals: GraphProposal[] }>(garden.rest, path.graphProposals);
  const write = useWrite(garden.rest);
  const decide = (proposal: GraphProposal, decision: 'approve' | 'reject') =>
    write.run(path.decideGraphProposal(proposal.id, decision), decision === 'approve' ? { method: 'POST', body: {} } : { method: 'POST' }, proposals.reload);
  return (
    <>
      <Section title="Contacts">
        <Show loaded={contacts}>
          {(c) => c.contacts.length === 0 ? <Empty what="contacts" /> : c.contacts.map((contact) => (
            <Card key={contact.id} label={`contact ${contact.id}`}>
              <strong>{contact.displayName}</strong> <Muted>{contact.trustLevel} · {contact.relationshipType} · last seen {contact.lastSeen}</Muted>
            </Card>
          ))}
        </Show>
      </Section>
      <Section title="Biographical claims">
        <Show loaded={claims}>
          {(c) => c.claims.length === 0 ? <Empty what="claims" /> : (
            <ul>{c.claims.map((claim) => <li key={claim.id}>{claim.kind} <Muted>· {claim.status}{claim.derivation === undefined ? '' : ` · ${claim.derivation}`}</Muted></li>)}</ul>
          )}
        </Show>
      </Section>
      <Section title="Relationship proposals">
        <Failure error={write.error} />
        <Show loaded={proposals}>
          {(p) => p.proposals.length === 0 ? <Empty what="relationship proposals" /> : p.proposals.map((proposal) => (
            <Card key={proposal.id} label={`relationship ${proposal.id}`}>
              {proposal.sourceDisplayName} → {proposal.targetDisplayName}: {proposal.relationshipType} <Muted>· {proposal.status}</Muted>
              <div><Muted>{proposal.rationale}</Muted></div>
              {proposal.status === 'pending' && (
                <div>
                  <button type="button" disabled={write.busy} onClick={() => decide(proposal, 'approve')}>Approve</button>{' '}
                  <button type="button" disabled={write.busy} onClick={() => decide(proposal, 'reject')}>Reject</button>
                </div>
              )}
            </Card>
          ))}
        </Show>
      </Section>
    </>
  );
}

/** One turn's detail: the prompt it ran with, the memories it recalled and wrote, and the tools it used. */
function TurnDetailView({ garden, conversationKey, turnId }: { garden: Garden; conversationKey: string; turnId: string }) {
  const detail = useLoad<TurnDetail>(garden.rest, path.sessionTurn(conversationKey, turnId));
  return (
    <Show loaded={detail}>
      {({ turn }) => (
        <Facts rows={[
          ['Status', turn.record.status],
          ['Prompt', [turn.record.versionPointers?.model, turn.record.versionPointers?.promptMode, turn.record.versionPointers?.promptHash].filter((v) => v !== undefined).join(' · ') || '—'],
          ['Memories recalled', turn.retrievals.length === 0 ? 'none' : turn.retrievals.map((r) => `${r.count}${r.retrievalSource === undefined ? '' : ` (${r.retrievalSource})`}`).join(', ')],
          ['Memories written', String(turn.record.extractedMemoryIds.length)],
          ['Tools', turn.record.toolCalls.length === 0 ? 'none' : turn.record.toolCalls.map((t) => `${t.toolName}${t.outcome === undefined ? '' : ` (${t.outcome})`}`).join(', ')],
        ]} />
      )}
    </Show>
  );
}

function Conversation({ garden, conversationKey }: { garden: Garden; conversationKey: string }) {
  const messages = useLoad<SessionMessages>(garden.rest, path.sessionMessages(conversationKey));
  const [turnId, setTurnId] = useState<string | null>(null);
  return (
    <Show loaded={messages}>
      {(m) => (
        <>
          <Section title="Turns">
            {m.turns.length === 0 ? <Empty what="recorded turns" /> : m.turns.map(({ record }) => (
              <Card key={record.turnId} label={`turn ${record.turnId}`}>
                <button type="button" onClick={() => setTurnId(turnId === record.turnId ? null : record.turnId)}>{when(record.startedAt)}</button>{' '}
                <Muted>{record.status}</Muted>
                <div style={{ whiteSpace: 'pre-wrap' }}>{clip(record.userMessage?.content ?? '', 160)}</div>
                {turnId === record.turnId && <TurnDetailView garden={garden} conversationKey={conversationKey} turnId={record.turnId} />}
              </Card>
            ))}
          </Section>
          <Section title="Messages"><TurnList turns={m.messages} /></Section>
        </>
      )}
    </Show>
  );
}

function SessionsScreen({ garden }: { garden: Garden }) {
  const sessions = useLoad<SessionList>(garden.rest, path.sessions);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Show loaded={sessions}>
      {(s) => s.channels.length === 0 ? <Empty what="sessions" /> : (
        <>
          {s.channels.map((row) => (
            <Card key={row.sessionId} label={`session ${row.sessionId}`}>
              <button type="button" onClick={() => setOpen(open === row.channelId ? null : row.channelId)}>{row.channelId}</button>{' '}
              <Muted>{row.messageCount} messages · {when(row.lastActivityAt)}</Muted>
              {open === row.channelId && <Conversation garden={garden} conversationKey={row.channelId} />}
            </Card>
          ))}
        </>
      )}
    </Show>
  );
}

function ConcernRow({ garden, concern, onChanged }: { garden: Garden; concern: Concern; onChanged: () => void }) {
  const write = useWrite(garden.rest);
  const [status, setStatus] = useState(concern.status);
  return (
    <Card label={`concern ${concern.id}`}>
      <div>{concern.text}</div>
      <Muted>{concern.priority} · {concern.status} · {concern.createdAt}</Muted>
      <Failure error={write.error} />
      <div>
        <button type="button" disabled={write.busy || concern.status === 'resolved'} onClick={() => write.run(path.resolveConcern(concern.id), { method: 'POST', body: {} }, onChanged)}>Resolve</button>{' '}
        <select aria-label={`status of ${concern.id}`} value={status} onChange={(e) => setStatus(e.target.value)}>
          {CONCERN_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>{' '}
        <button type="button" disabled={write.busy || status === concern.status} onClick={() => write.run(path.transitionConcern(concern.id), { method: 'POST', body: { status } }, onChanged)}>Move</button>
      </div>
    </Card>
  );
}

function InnerLifeScreen({ garden }: { garden: Garden }) {
  const inner = useLoad<InnerLife>(garden.rest, path.innerLife);
  const concerns = useLoad<{ concerns: Concern[] }>(garden.rest, path.concerns);
  const schedule = useLoad<Overview['heartbeat']>(garden.rest, path.schedule);
  return (
    <>
      <Section title="Concerns">
        <Show loaded={concerns}>
          {(c) => c.concerns.length === 0 ? <Empty what="concerns" /> : c.concerns.map((concern) => <ConcernRow key={concern.id} garden={garden} concern={concern} onChanged={concerns.reload} />)}
        </Show>
      </Section>
      <Show loaded={inner}>
        {(i) => (
          <>
            <Section title="Focus"><FocusList focus={i.focus} /></Section>
            <Section title="Emotion"><EmotionFacts emotion={i.emotion} /></Section>
            <Section title="Rhythm">
              <Facts rows={[
                ['Introspection', `${i.introspectionConsent.enabled ? 'on' : 'off'} (${i.introspectionConsent.status})`],
                ['Wake window', i.wakeWindow === null ? '—' : `${i.wakeWindow.effective.localTime} ${i.wakeWindow.timeZone} (${i.wakeWindow.timingMode}, ${i.wakeWindow.source})`],
              ]} />
            </Section>
          </>
        )}
      </Show>
      <Section title="Schedules and heartbeat">
        <Show loaded={schedule}>
          {(h) => (
            <>
              <ul>{h.tasks.map((task) => <li key={task.id}>{task.name} <Muted>· {task.state} · every {Math.round((task.intervalMs ?? 0) / 60_000)} min · last run {when(task.lastRunAt)}</Muted></li>)}</ul>
              <ul>{h.reflections.map((r) => <li key={r.id}>{r.name} <Muted>· reflection · {r.enabled ? 'on' : 'off'}{r.mode === undefined ? '' : ` · ${r.mode}`}</Muted></li>)}</ul>
            </>
          )}
        </Show>
      </Section>
    </>
  );
}

function AutomataScreen({ garden }: { garden: Garden }) {
  const [inspect, setInspect] = useState<string | null>(null);
  const automata = useLoad<Automata>(garden.rest, path.automata(inspect));
  return (
    <Show loaded={automata}>
      {(a) => {
        const health = new Map((a.coverage?.classes ?? []).map((c) => [c.automatonClass, c]));
        return (
          <>
            <Section title="Classes">
              {a.classes.length === 0 ? <Empty what="automata" /> : (
                <ul>
                  {a.classes.map((c) => {
                    const seen = health.get(c.id);
                    return (
                      <li key={c.id}>
                        {c.id} <Muted>· {c.workerKind} · {c.trigger}{seen === undefined ? '' : ` · ${seen.health}, ${seen.runs.total} runs, ${seen.runs.active} active, ${seen.runs.failed} failed`}</Muted>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
            <Section title="Recent runs">
              {a.runs.length === 0 ? <Empty what="runs" /> : (
                <ul>
                  {a.runs.map((run) => (
                    <li key={run.runId}>
                      {run.taskLabel ?? run.automatonClass} <Muted>· {run.automatonClass} · {run.status}</Muted>{' '}
                      <button type="button" onClick={() => setInspect(inspect === run.runId ? null : run.runId)}>{inspect === run.runId ? 'All bus events' : 'Inspect'}</button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title={inspect === null ? 'Bus' : `Bus events of run ${inspect}`}>
              {a.bus === null || !a.bus.available ? <Empty what="bus" /> : (
                <>
                  {a.bus.health !== undefined && <p><Muted>{a.bus.health.condition} · {a.bus.health.freshness}</Muted></p>}
                  {a.bus.events.length === 0 ? <Empty what="bus events" /> : (
                    <ul>{a.bus.events.map((event) => <li key={event.eventId}>#{event.sequence} {event.type} <Muted>· {event.occurredAt}</Muted></li>)}</ul>
                  )}
                </>
              )}
            </Section>
          </>
        );
      }}
    </Show>
  );
}

function SettingsScreen({ garden }: { garden: Garden }) {
  const settings = useLoad<Settings>(garden.rest, path.settings);
  const write = useWrite(garden.rest);
  const [tier, setTier] = useState<string | null>(null);
  const [scheduler, setScheduler] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const done = (answer: SettingsSaved) => {
    setSaved(answer.restartRequired);
    setTier(null);
    setScheduler(null);
    settings.reload();
  };
  const saveScheduler = (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setInvalid('The scheduler settings are not valid JSON.');
      return;
    }
    setInvalid(null);
    write.run(path.scheduler, { method: 'PUT', body: parsed }, done);
  };
  return (
    <Show loaded={settings}>
      {(s) => (
        <>
          {saved && <RestartNeeded />}
          <Failure error={invalid ?? write.error} />
          <Section title="Model">
            <Facts rows={[['Provider', s.model.provider], ['Model', s.model.modelId]]} />
            <p><Muted>Set in the standalone config.</Muted></p>
          </Section>
          <Section title="Capability tier">
            <select aria-label="Capability tier" value={tier ?? s.tier.tier} onChange={(e) => setTier(e.target.value)}>
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>{' '}
            <button type="button" disabled={write.busy || tier === null || tier === s.tier.tier}
              onClick={() => write.run(path.tier, { method: 'PUT', body: { tier, customTokens: s.tier.customTokens } }, done)}>Save tier</button>
          </Section>
          <Section title="Scheduler">
            <textarea aria-label="Scheduler settings" rows={16} style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }}
              value={scheduler ?? JSON.stringify(s.scheduler, null, 2)} onChange={(e) => setScheduler(e.target.value)} />
            <button type="button" disabled={write.busy || scheduler === null} onClick={() => saveScheduler(scheduler ?? '')}>Save scheduler</button>
          </Section>
        </>
      )}
    </Show>
  );
}

