import { Marked } from 'marked';

/** Egress packaging — specs.md §7.2-C. */

export interface Member {
  userId: string;
  displayName: string;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Model output is untrusted: raw HTML is rendered as text, never passed through.
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: { html: ({ text }) => escapeHtml(text) },
});

/** Removes a <speaker> wrapper if the model echoed the context format back. */
export function stripSpeakerFrame(text: string) {
  const m = text.trim().match(/^<speaker\b[^>]*>([\s\S]*?)<\/speaker>$/);
  return (m ? m[1] : text).trim();
}

export function buildMessageContent(opts: {
  text: string;
  members: Member[];
  threadRoot?: string;
  inReplyTo?: string;
}): Record<string, unknown> {
  const body = stripSpeakerFrame(opts.text);
  let html = markdown.parse(body, { async: false }).trim();

  // "@Display Name" → mention pill; longest names first so "Bob Smith" wins over "Bob".
  const mentioned = new Set<string>();
  const members = [...opts.members].filter((m) => m.displayName).sort((a, b) => b.displayName.length - a.displayName.length);
  for (const member of members) {
    const pattern = new RegExp(`@${escapeRegExp(escapeHtml(member.displayName))}(?![\\w])`, 'g');
    html = html.replace(pattern, () => {
      mentioned.add(member.userId);
      return `<a href="https://matrix.to/#/${member.userId}">${escapeHtml(member.displayName)}</a>`;
    });
  }
  if (html === `<p>${escapeHtml(body)}</p>` && mentioned.size === 0) html = '';

  const content: Record<string, unknown> = {
    msgtype: 'm.text',
    body,
    'm.mentions': { user_ids: [...mentioned] },
  };
  if (html) {
    content.format = 'org.matrix.custom.html';
    content.formatted_body = html;
  }
  if (opts.threadRoot) {
    content['m.relates_to'] = {
      rel_type: 'm.thread',
      event_id: opts.threadRoot,
      is_falling_back: false,
      ...(opts.inReplyTo ? { 'm.in_reply_to': { event_id: opts.inReplyTo } } : {}),
    };
  }
  return content;
}
