/**
 * The Garden's shared pieces: loading a read, running a write, and a few
 * plain elements. Styles are inline and use Desktop's own CSS variables: a
 * runtime plugin's class names are not in the host's compiled stylesheet.
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { errorText, type Garden, type Rest, type RestOptions } from './api.ts';

export const SCREENS = [
  { key: 'overview', path: '/garden', title: 'Overview' },
  { key: 'memories', path: '/garden-memories', title: 'Memories' },
  { key: 'persona', path: '/garden-persona', title: 'Persona & prompts' },
  { key: 'people', path: '/garden-people', title: 'People' },
  { key: 'sessions', path: '/garden-sessions', title: 'Sessions' },
  { key: 'inner-life', path: '/garden-inner-life', title: 'Inner life' },
  { key: 'automata', path: '/garden-automata', title: 'Automata' },
  { key: 'settings', path: '/garden-settings', title: 'Settings' },
] as const;
export type ScreenKey = (typeof SCREENS)[number]['key'];

const muted: CSSProperties = { color: 'var(--ui-text-tertiary)' };
const box: CSSProperties = { border: '1px solid var(--ui-border, rgba(127,127,127,0.25))', borderRadius: 6, padding: '8px 10px', margin: '6px 0' };

export interface Loaded<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

/** One read; `path` null loads nothing. A newer load wins over an older one still in flight. */
export function useLoad<T>(rest: Rest, path: string | null): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: path !== null });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (path === null) return undefined;
    let current = true;
    setState((previous) => ({ ...previous, loading: true }));
    void rest<T>(path).then(
      (data) => {
        if (current) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (current) setState({ data: null, error: errorText(error), loading: false });
      },
    );
    return () => {
      current = false;
    };
  }, [rest, path, generation]);
  const reload = useCallback(() => setGeneration((n) => n + 1), []);
  return { ...state, reload };
}

export interface Write {
  readonly busy: boolean;
  readonly error: string | null;
  readonly run: <T>(path: string, options: RestOptions, then?: (answer: T) => void) => void;
}

/** A write: one at a time, its failure shown where it was asked for. */
export function useWrite(rest: Rest): Write {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(<T,>(path: string, options: RestOptions, then?: (answer: T) => void) => {
    setBusy(true);
    setError(null);
    void rest<T>(path, options).then(
      (answer) => {
        setBusy(false);
        then?.(answer);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(errorText(failure));
      },
    );
  }, [rest]);
  return { busy, error, run };
}

export function Page({ garden, screen, children }: { garden: Garden; screen: ScreenKey; children: ReactNode }) {
  const title = SCREENS.find((s) => s.key === screen)?.title ?? 'Garden';
  return (
    <div style={{ padding: '12px 16px', overflow: 'auto', height: '100%', boxSizing: 'border-box' }} data-garden-screen={screen}>
      <nav aria-label="Garden" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
        {SCREENS.map((s) => (
          <button key={s.key} type="button" aria-current={s.key === screen ? 'page' : undefined} onClick={() => garden.navigate(s.path)}
            style={{ fontWeight: s.key === screen ? 600 : 400, padding: '2px 8px' }}>
            {s.title}
          </button>
        ))}
      </nav>
      <h1 style={{ fontSize: '1.1rem', margin: '4px 0 10px' }}>{title}</h1>
      {children}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ margin: '12px 0' }}>
      <h2 style={{ fontSize: '0.95rem', margin: '0 0 6px' }}>{title}</h2>
      {children}
    </section>
  );
}

export function Card({ children, label }: { children: ReactNode; label?: string }) {
  return <div style={box} aria-label={label}>{children}</div>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <span style={muted}>{children}</span>;
}

export function Failure({ error }: { error: string | null }) {
  return error === null ? null : <p role="alert" style={{ color: 'var(--ui-text-danger, #c33)' }}>{error}</p>;
}

/** The read's state: loading, its error, or the screen. */
export function Show<T>({ loaded, children }: { loaded: Loaded<T>; children: (data: T) => ReactNode }) {
  if (loaded.error !== null) return <Failure error={loaded.error} />;
  if (loaded.data === null) return <Muted>Loading…</Muted>;
  return <>{children(loaded.data)}</>;
}

export function Empty({ what }: { what: string }) {
  return <p><Muted>No {what}.</Muted></p>;
}

/** Rows of label and value. */
export function Facts({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: 0 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt style={muted}>{label}</dt>
          <dd style={{ margin: 0 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RestartNeeded() {
  return <p role="status"><strong>Restart Lite to apply the saved settings.</strong> The running companion still uses the settings it started with.</p>;
}

export function when(epochMs: number | undefined): string {
  return epochMs === undefined ? '—' : new Date(epochMs).toLocaleString();
}

export function clip(text: string, limit = 240): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
