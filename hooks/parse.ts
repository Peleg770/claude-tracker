import type { TrackerDone, TrackerFilter, TrackerItem, TrackerTone } from '../types'

export type SlackHit = {
  channel: string
  channelName: string
  isDm: boolean
  fromId: string
  fromName: string
  /** An app or bot, not a person: `[BOT]`, a `B…` id, or no name at all. */
  isBot: boolean
  ts: string
  threadTs?: string
  permalink: string
  text: string
}

export type ThreadMessage = { fromId: string; fromName: string; isBot: boolean; ts: string; text: string }

export type PullRequest = {
  number: number
  title: string
  url: string
  isDraft?: boolean
  reviewDecision?: string
  updatedAt: string
  statusCheckRollup?: { conclusion?: string; state?: string; status?: string }[]
  repository?: { nameWithOwner?: string }
  author?: { login?: string }
}

/** The JSON a text-returning MCP tool answers, from its content blocks. */
export function mcpJson(content: readonly { type: string; text?: string }[]): unknown {
  const text = content.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
  return JSON.parse(text)
}

/**
 * Slack's markup as plain text: mentions and links by their labels, one line.
 * A mention of `me` is dropped: in my own tracker it says nothing.
 */
export function cleanSlack(text: string, me?: string): string {
  const own = me === undefined ? text : text.replace(new RegExp(`<@${me}(\\|[^>]*)?>`, 'g'), '')

  return own
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function field(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`^${name}: ?(.*)$`, 'm'))
  return match?.[1]?.trim()
}

/** The hits of a Slack search answered in the `detailed` format. */
export function parseSlackResults(results: string, me?: string): SlackHit[] {
  return results
    .split(/^### Result \d+ of \d+\s*$/m)
    .slice(1)
    .flatMap(block => {
      const channelLine = field(block, 'Channel') ?? ''
      const channel = channelLine.match(/\(ID: ([A-Z0-9]+)\)/)?.[1]
      const fromLine = field(block, 'From') ?? ''
      const from = fromLine.match(/^(.*?)\s*(?:<[^>]*>)?\s*\(ID: ([A-Z0-9]+)\)/)
      const ts = field(block, 'Message_ts')
      const permalink = (field(block, 'Permalink') ?? '').match(/\((https?:[^)]+)\)/)?.[1] ?? ''
      const fromName = from?.[1]
      const fromId = from?.[2]
      if (channel === undefined || fromName === undefined || fromId === undefined || ts === undefined) return []
      const text = block.split(/^Text: ?$/m)[1]?.split(/^---$/m)[0] ?? ''

      return [
        {
          channel,
          channelName: channelLine.replace(/\s*\(ID:.*$/, ''),
          isDm: channel.startsWith('D') || channelLine.startsWith('DM') || channelLine.startsWith('Group DM'),
          fromId,
          fromName: fromName.trim(),
          isBot: fromLine.includes('[BOT]') || fromId.startsWith('B') || fromName.trim() === '',
          ts,
          threadTs: permalink.match(/thread_ts=([0-9.]+)/)?.[1],
          permalink,
          text: cleanSlack(text, me),
        },
      ]
    })
}

/** The parent and replies of a Slack thread answered in the `detailed` format. */
export function parseThread(messages: string, me?: string): ThreadMessage[] {
  return messages
    .split(/^From: /m)
    .slice(1)
    .flatMap(chunk => {
      const head = chunk.match(/^(.*?)\s*(?:<[^>]*>)?\s*\(([A-Z0-9]+)\)\s*$/m)
      const ts = chunk.match(/^Message TS: ([0-9.]+)/m)?.[1]
      const fromName = head?.[1]
      const fromId = head?.[2]
      if (fromName === undefined || fromId === undefined || ts === undefined) return []
      const body = chunk
        .split('\n')
        .slice(3)
        .filter(line => !/^(===|---|Reactions:|Forwarded message|No thread mess+ages)/.test(line))
        .join(' ')

      return [
        { fromId, fromName: fromName.trim(), isBot: fromId.startsWith('B') || fromName.trim() === '', ts, text: cleanSlack(body, me) },
      ]
    })
}

/**
 * Cleaned Slack text as a person reads it: no `:emoji:` codes, no bold, code
 * or strike markers, and no "X button" leftovers of a bot's block buttons.
 */
export function readable(text: string): string {
  return text
    .replace(/:[a-z0-9_+-]+:/g, '')
    .replace(/[*`~]/g, '')
    .replace(/\b(View run|PR #\d+|Open|View) button\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Channel ids by bare name, from a `concise` channel search: `1. #dev (C01DEV00001) - …`. */
export function parseChannelList(results: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const match of results.matchAll(/^\d+\. #([^\s(]+) \(([A-Z0-9]+)\)/gm)) found[match[1]!] = match[2]!

  return found
}

/** Whether a row answers a search: every word appears in its title, status or detail. */
export function matches(item: TrackerItem, query: string): boolean {
  const haystack = `${item.title} ${item.status} ${item.detail}`.toLowerCase()

  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word))
}

/** The emoji each tab and section heading wears. */
export const TAB_ICONS: Record<TrackerFilter, string> = {
  all: '📌',
  urgent: '🔥',
  done: '✅',
  slack: '💬',
  pr: '🔀',
  linear: '📋',
  session: '🤖',
}

// Single-code-point emoji only: a VS16 one (⚠️, ✏️) is drawn one cell wide by
// some terminals and two by others, and shifts the row behind it.
const STATUS_ICONS: Record<string, string> = {
  'direct message': '💬',
  'replied in a DM thread': '💬',
  'mentioned you': '📣',
  'replied in your thread': '🧵',
  'review requested': '👀',
  'checks failing': '❌',
  'changes requested': '📝',
  'approved, ready to merge': '✅',
  'checks running': '⏳',
  draft: '🚧',
  'waiting for review': '💤',
}

/** The emoji a row starts with: what happened, else where it came from. */
export function iconFor(item: Pick<TrackerItem, 'source' | 'status'>): string {
  return STATUS_ICONS[item.status] ?? TAB_ICONS[item.source]
}

/** A status word as a label: its first letter capital. */
export function label(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Where a PR of mine stands, in the words the row shows. */
export function prStatus(pr: PullRequest): string {
  const checks = (pr.statusCheckRollup ?? []).map(c => c.conclusion || c.state || c.status || '')
  const failing = checks.some(c => /FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/.test(c))
  const pending = checks.some(c => /PENDING|IN_PROGRESS|QUEUED|EXPECTED/.test(c))
  if (failing) return 'checks failing'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested'
  if (pr.isDraft) return 'draft'
  if (pending) return 'checks running'
  if (pr.reviewDecision === 'APPROVED') return 'approved, ready to merge'

  return 'waiting for review'
}

/** The tone a PR status word is drawn in: red blocks, amber needs a hand, green ships. */
export function prTone(status: string): TrackerTone {
  if (status === 'checks failing') return 'error'
  if (status === 'changes requested') return 'warning'
  if (status === 'approved, ready to merge') return 'success'

  return 'subtle'
}

/** How long a row stays in the Done tab after "done". */
export const DONE_KEEP_MS = 48 * 60 * 60 * 1000

/** The done log without entries older than `DONE_KEEP_MS`. */
export function pruneDone(log: Readonly<Record<string, TrackerDone>>, now: number): Record<string, TrackerDone> {
  return Object.fromEntries(Object.entries(log).filter(([, entry]) => now - entry.at < DONE_KEEP_MS))
}

/** The items "done" has not hidden: hidden until the item's stamp changes. */
export function visible(items: readonly TrackerItem[], dismissed: Readonly<Record<string, string>>): TrackerItem[] {
  return items.filter(item => dismissed[item.id] !== item.stamp)
}

/** "3m", "5h", "2d": how long ago `at` was. */
export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`

  return `${Math.round(minutes / 60 / 24)}d`
}

/** The newest prompt per session id, from `~/.claude/history.jsonl`. */
export function lastPrompts(history: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const line of history.split('\n')) {
    if (line === '') continue
    try {
      const row = JSON.parse(line) as { display?: string; sessionId?: string }
      if (row.sessionId !== undefined && row.display !== undefined) found[row.sessionId] = row.display
    } catch {
      // A line cut mid-write: skip it.
    }
  }

  return found
}

