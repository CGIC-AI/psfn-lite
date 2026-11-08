// ── Host notification port ──
//
// Lite extraction (seam 3.2, gateway cut). The core keeps the optional
// notification port its consumers already accept as `NotificationPort | null`
// (the artifact-egress approval notifier on the substrate agent, the turn
// execution adapter and runtime contracts, and core/artifacts/sensitivity-egress.ts).
// The donor's implementations (the gateway `notify.ntfy` RPC and the ntfy HTTP
// notifier in core/tools/ntfy.ts) are outside the core: delivery belongs to the
// host, which wires a port or passes null.
//
// Declarations copied verbatim from the donor at e6a9546:
// src/boundary/gateway/notification-sender.ts (whole file, lines 1-38),
// src/boundary/gateway/protocol.ts (NotifyNtfyParams 703-711, NotifyNtfyResult 1109-1113),
// src/boundary/gateway/notification-port.ts (NotificationPort, lines 3-5).

export const NOTIFICATION_SENDER_KINDS = ['companion', 'system'] as const;

export type NotificationSenderKind = (typeof NOTIFICATION_SENDER_KINDS)[number];

export interface NotificationSenderMetadata {
  kind: NotificationSenderKind;
  provenance: string;
}

const NOTIFICATION_PROVENANCE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function normalizeNotificationSenderMetadata(
  sender: unknown,
): NotificationSenderMetadata {
  if (!sender || typeof sender !== 'object') {
    throw new Error('notify sender metadata is required');
  }

  const record = sender as { kind?: unknown; provenance?: unknown };

  const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
  if (kind !== 'companion' && kind !== 'system') {
    throw new Error('notify sender kind must be "companion" or "system"');
  }

  const provenance = typeof record.provenance === 'string' ? record.provenance.trim() : '';
  if (!provenance) {
    throw new Error('notify sender provenance is required');
  }
  if (!NOTIFICATION_PROVENANCE_PATTERN.test(provenance)) {
    throw new Error('notify sender provenance must be a lowercase dotted, dashed, or underscored identifier');
  }
  if (!provenance.startsWith(`${kind}.`)) {
    throw new Error(`notify sender provenance must start with "${kind}."`);
  }

  return { kind, provenance };
}

export interface NotifyNtfyParams {
  message: string;
  title?: string;
  priority?: number;
  topic?: string;
  /** Stable caller key for providers that can collapse ambiguous retries. */
  idempotencyKey?: string;
  sender: NotificationSenderMetadata;
}

export interface NotifyNtfyResult {
  status: 'sent' | 'debounced';
  topic: string;
  messageId?: string;
}

export interface NotificationPort {
  notify(params: NotifyNtfyParams): Promise<NotifyNtfyResult>;
}
