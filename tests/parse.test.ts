import { expect, test } from 'claude-code/testing'

import {
  calendarRows,
  cleanSlack,
  detectSources,
  gmailRows,
  iconFor,
  jiraIssues,
  jiraRank,
  label,
  lastPrompts,
  matches,
  parseChannelList,
  parseSlackResults,
  parseThread,
  pruneDone,
  prStatus,
  prTone,
  readable,
  senderName,
  visible,
} from '../hooks/parse'

const SEARCH = `# Search Results for:

## Messages (2 results)
### Result 1 of 2
Channel: #general (ID: C01GENERAL1)
From: Alex Rivera <alex@example.com> (ID: U01ALEX0001)
Time: 2026-10-06 12:26:16 IDT
Message_ts: 1791278776.251409
Reply count: 1
Permalink: [link](https://peleg123.slack.com/archives/C01GENERAL1/p1791278776251409?thread_ts=1791278776.251409&cid=C01GENERAL1)
Text:
<@U01PELEG123|Peleg123> FYI see <https://example.com/x|the doc>

---

### Result 2 of 2
Channel: DM (ID: D01DIRECT01)
Participants: Alex Rivera (ID: U01ALEX0001), Peleg123 (ID: U01PELEG123)
From: Peleg123 <peleg123@example.com> (ID: U01PELEG123)
Time: 2026-10-06 08:25:06 IDT
Message_ts: 1791264306.424049
Permalink: [link](https://peleg123.slack.com/archives/D01DIRECT01/p1791264306424049)
Text:
two
lines

---

`

const THREAD = `=== THREAD PARENT MESSAGE ===
From: Alex Rivera <alex@example.com> (U01ALEX0001)
Time: 2026-10-06 12:26:16 IDT
Message TS: 1791278776.251409
<@U01PELEG123|Peleg123> FYI
Reactions: heavy_plus_sign (1)

=== THREAD REPLIES (1 total) ===

--- Reply 1 of 1 ---
From: Peleg123 <peleg123@example.com> (U01PELEG123)
Time: 2026-10-06 12:34:41 IDT
Message TS: 1791279281.399509
on it
`

test('a Slack search parses into hits with channel, author, thread and text', async () => {
  const [mention, dm] = parseSlackResults(SEARCH)
  expect(mention).toEqual({
    channel: 'C01GENERAL1',
    channelName: '#general',
    isDm: false,
    fromId: 'U01ALEX0001',
    fromName: 'Alex Rivera',
    isBot: false,
    ts: '1791278776.251409',
    threadTs: '1791278776.251409',
    permalink:
      'https://peleg123.slack.com/archives/C01GENERAL1/p1791278776251409?thread_ts=1791278776.251409&cid=C01GENERAL1',
    text: '@Peleg123 FYI see the doc',
  })
  expect(dm?.isDm).toBe(true)
  expect(dm?.fromId).toBe('U01PELEG123')
  expect(dm?.threadTs).toBeUndefined()
  expect(dm?.text).toBe('two lines')
})

test("a thread's last message names who spoke last", async () => {
  const messages = parseThread(THREAD)
  expect(messages.length).toBe(2)
  expect(messages[0]?.text).toBe('@Peleg123 FYI')
  expect(messages.at(-1)).toEqual({
    fromId: 'U01PELEG123',
    fromName: 'Peleg123',
    isBot: false,
    ts: '1791279281.399509',
    text: 'on it',
  })
})

test('a PR status puts failing checks first, then review state', async () => {
  const base = { number: 1, title: 't', url: 'u', updatedAt: '2026-10-05T12:00:00Z' }
  expect(prStatus({ ...base, reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'SUCCESS' }] })).toBe(
    'approved, ready to merge',
  )
  expect(prStatus({ ...base, reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'FAILURE' }] })).toBe(
    'checks failing',
  )
  expect(prStatus({ ...base, reviewDecision: 'CHANGES_REQUESTED' })).toBe('changes requested')
  expect(prStatus({ ...base, isDraft: true, reviewDecision: 'REVIEW_REQUIRED' })).toBe('draft')
  expect(prStatus({ ...base, reviewDecision: 'REVIEW_REQUIRED' })).toBe('waiting for review')
})

test('done hides an item until its stamp changes', async () => {
  const item = {
    id: 'pr:1', source: 'pr' as const, title: 't', status: 's', tone: 'subtle' as const,
    detail: 'd', stamp: 'a', at: 0, when: 0,
  }
  expect(visible([item], { 'pr:1': 'a' })).toEqual([])
  expect(visible([{ ...item, stamp: 'b' }], { 'pr:1': 'a' }).length).toBe(1)
})

test('the newest prompt per session wins and a cut line is skipped', async () => {
  const history = [
    '{"display":"first","sessionId":"s1"}',
    '{"display":"second","sessionId":"s1"}',
    '{"display":"other","sessionId":"s2"}',
    '{"display":"cut',
  ].join('\n')
  expect(lastPrompts(history)).toEqual({ s1: 'second', s2: 'other' })
  expect(cleanSlack('<https://a.b>  x')).toBe('https://a.b x')
})

test('a PR status word is coloured by what it asks of me', async () => {
  expect(prTone('checks failing')).toBe('error')
  expect(prTone('changes requested')).toBe('warning')
  expect(prTone('approved, ready to merge')).toBe('success')
  expect(prTone('waiting for review')).toBe('subtle')
  expect(prTone('draft')).toBe('subtle')
})

const BOT_THREAD = `=== THREAD PARENT MESSAGE ===
From:  (B01BOT00001)
Time: 2026-10-05 17:17:15 IDT
Message TS: 1791209835.179309
<@U01PELEG123|Peleg123>
:red_circle: feat/add-dark-mode · not passed
`

test('a bot message is flagged and my own mention dropped from it', async () => {
  const [notice] = parseThread(BOT_THREAD, 'U01PELEG123')
  expect(notice?.isBot).toBe(true)
  expect(notice?.text.startsWith('@')).toBe(false)
  expect(parseThread(THREAD)[0]?.isBot).toBe(false)
  expect(parseSlackResults(SEARCH).map(hit => hit.isBot)).toEqual([false, false])
})

test('a channel search reads as ids by bare name', async () => {
  const results = `## Channels (2 results)
1. #design (C01DESIGN01) - public_channel - x
2. #dev (C01DEV00001) - public_channel - y
`
  expect(parseChannelList(results)).toEqual({ 'design': 'C01DESIGN01', dev: 'C01DEV00001' })
})

test('readable drops emoji codes, markup and bot button labels', async () => {
  expect(readable(':red_circle: *Image tag* `pr-2822` View run button PR #2822 button')).toBe('Image tag pr-2822')
  expect(label('checks failing')).toBe('Checks failing')
})

test('search matches every word across title, status and detail', async () => {
  const item = {
    id: 'pr:1', source: 'pr' as const, title: '#2701 fix(web): filter bar', status: 'checks failing',
    tone: 'error' as const, detail: 'Your PR', stamp: 'a', at: 0, when: 0,
  }
  expect(matches(item, '2701 failing')).toBe(true)
  expect(matches(item, 'FILTER')).toBe(true)
  expect(matches(item, 'slack')).toBe(false)
  expect(matches(item, '')).toBe(true)
})

test('a row wears the emoji of what happened, else of its source', async () => {
  expect(iconFor({ source: 'pr', status: 'checks failing' })).toBe('❌')
  expect(iconFor({ source: 'slack', status: 'mentioned you' })).toBe('📣')
  expect(iconFor({ source: 'linear', status: 'In Progress' })).toBe('📋')
  expect(iconFor({ source: 'session', status: 'idle, waiting for you' })).toBe('🤖')
})

test('the done log keeps 48 hours and drops the rest', async () => {
  const item = {
    id: 'pr:1', source: 'pr' as const, title: 't', status: 's', tone: 'subtle' as const,
    detail: 'd', stamp: 'a', at: 0, when: 0,
  }
  const now = Date.parse('2026-10-06T12:00:00Z')
  const hour = 60 * 60 * 1000
  const log = {
    fresh: { item, at: now - 47 * hour },
    stale: { item, at: now - 49 * hour },
  }
  expect(Object.keys(pruneDone(log, now))).toEqual(['fresh'])
})


test('detectSources finds each source by its tool, whatever the server is called', () => {
  const found = detectSources([
    { name: 'Read', mcp: false },
    { name: 'mcp__claude_ai_Slack__slack_search_public_and_private', mcp: true },
    { name: 'mcp__github__list_issues', mcp: true },
    { name: 'mcp__linear-server__list_issues', mcp: true },
    { name: 'mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql', mcp: true },
    { name: 'mcp__claude_ai_Gmail__search_threads', mcp: true },
    { name: 'mcp__claude_ai_Google_Calendar__list_events', mcp: true },
  ])
  expect(found).toEqual({
    slack: 'claude_ai_Slack',
    linear: 'linear-server',
    jira: 'claude_ai_Atlassian',
    gmail: 'claude_ai_Gmail',
    calendar: 'claude_ai_Google_Calendar',
  })
})

test('detectSources leaves out what is not connected', () => {
  expect(detectSources([{ name: 'mcp__github__list_issues', mcp: true }])).toEqual({})
})

test('jiraIssues reads both answer shapes and skips rows without a key', () => {
  const issue = { key: 'DES-12', fields: { summary: 'Pane spacing', priority: { name: 'High' } } }
  expect(jiraIssues({ issues: [issue, { id: 1 }] })).toEqual([issue])
  expect(jiraIssues({ issues: { nodes: [issue] } })).toEqual([issue])
  expect(jiraIssues('nope')).toEqual([])
})

test('jiraRank orders priority names, unknown as Medium', () => {
  expect(jiraRank('Highest')).toBe(1)
  expect(jiraRank('high')).toBe(2)
  expect(jiraRank('P3-ish')).toBe(3)
  expect(jiraRank(undefined)).toBe(3)
})

test('senderName reads a display name, else the address', () => {
  expect(senderName('"Dana Levi" <dana@example.com>')).toBe('Dana Levi')
  expect(senderName('Dana Levi <dana@example.com>')).toBe('Dana Levi')
  expect(senderName('dana@example.com')).toBe('dana@example.com')
})

test('gmailRows makes one row per thread, keyed by its newest message', () => {
  const rows = gmailRows({
    threads: [
      {
        id: 't1',
        messages: [
          { id: 'm1', subject: 'Design review', sender: 'Dana <dana@example.com>', date: '2026-10-10' },
          { id: 'm2', sender: 'Noa <noa@example.com>', date: '2026-10-11', snippet: 'any update?' },
        ],
      },
      { id: 't2', messages: [] },
    ],
  })
  expect(rows.length).toBe(1)
  expect(rows[0]!.title).toBe('Design review')
  expect(rows[0]!.detail).toBe('from Noa')
  expect(rows[0]!.stamp).toBe('m2')
  expect(rows[0]!.url).toBe('https://mail.google.com/mail/u/0/#inbox/t1')
  expect(gmailRows({})).toEqual([])
})

test('calendarRows keeps unanswered invites and accepted meetings starting soon', () => {
  const now = Date.parse('2026-10-12T09:00:00Z')
  const at = (minutes: number) => new Date(now + minutes * 60000).toISOString()
  const rows = calendarRows(
    {
      events: [
        { id: 'invite', summary: 'Crit', start: { dateTime: at(60 * 24) }, attendees: [{ self: true, responseStatus: 'needsAction' }] },
        { id: 'soon', summary: 'Standup', start: { dateTime: at(20) }, attendees: [{ self: true, responseStatus: 'accepted' }] },
        { id: 'later', summary: 'Lunch', start: { dateTime: at(300) }, attendees: [{ self: true, responseStatus: 'accepted' }] },
        { id: 'declined', summary: 'Sync', start: { dateTime: at(10) }, attendees: [{ self: true, responseStatus: 'declined' }] },
        { id: 'gone', status: 'cancelled', summary: 'Old', start: { dateTime: at(10) } },
        { id: 'allday', summary: 'Holiday', start: { date: '2026-10-13' } },
      ],
    },
    now,
    60 * 60 * 1000,
  )
  expect(rows.map(r => r.id)).toEqual(['calendar:invite', 'calendar:soon'])
  expect(rows[1]!.status).toBe('starting soon')
  expect(rows[1]!.at > rows[0]!.at).toBe(true)
  expect(rows[0]!.when).toBe(0)
})
