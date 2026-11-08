import { defineTool, type ActionDescriptor } from '../shared/index.ts';

const CONTACT_TOOL = 'src/core/contacts/tools.ts';
const RELATIONSHIP_TOOLS = 'src/core/contacts/relationship-tools.ts';
const VIEWER_ACCESS = 'src/core/contacts/contact-viewer-access.ts';

function contactRead(name: string, summary: string): ActionDescriptor {
  return {
    name,
    summary,
    access: 'read',
    privacy: 'audience_scoped',
    admission: 'public',
    restrictions: ['visibility_gated'],
    workers: 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths: [CONTACT_TOOL, VIEWER_ACCESS] },
  };
}

/**
 * Contact writes are gated by the caller's visibility of the target contact,
 * closing the donor gap where note/link/privacy/relationship/block writes did
 * not check visibility.
 */
function contactWrite(
  name: string,
  summary: string,
  extra: ActionDescriptor['restrictions'],
  paths: readonly string[] = [CONTACT_TOOL],
): ActionDescriptor {
  return {
    name,
    summary,
    access: 'write',
    privacy: 'audience_scoped',
    admission: 'public',
    restrictions: ['visibility_gated', ...extra],
    workers: 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths },
  };
}

export const contactTool = defineTool({
  name: 'contact',
  domain: 'contacts',
  summary: 'Contacts, trust, relationships and tracking consent, filtered by audience.',
  actions: [
    contactRead('list', 'Visible contacts.'),
    contactRead('search', 'Search visible contacts.'),
    contactRead('lookup', 'One contact by id or channel identity; invisible reads as missing.'),
    contactWrite('note', 'Append a companion-authored note about a visible contact.', ['companion_authored', 'append_only']),
    contactWrite('set_trust', 'Low-tier drift only (public/regular); high tiers are never written directly.', [
      'companion_authored',
      'foreground_only',
    ]),
    contactWrite('propose_trust', 'Propose promotion to trusted; an operator approves or denies.', ['proposal_only']),
    contactWrite(
      'set_relationship',
      'One rank at a time on the human ladder; family/partner and downgrades need approval.',
      ['companion_authored', 'approval_for_protected'],
      [RELATIONSHIP_TOOLS],
    ),
    contactWrite('propose_relationship', 'Propose family or partner; an operator approves or denies.', ['proposal_only'], [
      RELATIONSHIP_TOOLS,
    ]),
    contactWrite('link_identity', 'Link a verified channel identity to a visible contact.', [
      'companion_authored',
      'approval_for_protected',
    ]),
    contactWrite('set_channel_privacy', 'Set a visible contact channel privacy level.', ['companion_authored']),
    contactWrite('set_machine_intelligence', 'Mark a contact as a machine intelligence; operator corrections win.', [
      'companion_authored',
    ]),
    contactWrite('block', 'Block a visible contact.', ['companion_authored', 'foreground_only']),
    contactWrite('unblock', 'Unblock a contact.', ['companion_authored', 'foreground_only']),
  ],
});
