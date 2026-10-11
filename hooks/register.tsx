import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TrackerDone, TrackerFilter, TrackerItem, TrackerSource, TrackerTone } from '../types'
import {
  ago,
  detectSources,
  iconFor,
  jiraIssues,
  jiraRank,
  label,
  lastPrompts,
  matches,
  mcpJson,
  parseChannelList,
  parseSlackResults,
  parseThread,
  pruneDone,
  prStatus,
  prTone,
  readable,
  TAB_ICONS,
  visible,
  type PullRequest,
  type SlackHit,
} from './parse'

const PANE = 'tracker'
const REMOTE_EVERY_MS = 5 * 60 * 1000
const SESSIONS_EVERY_MS = 20 * 1000
const SLACK_DAYS = 7
const THREADS_CHECKED = 12
const SHOWN_PER_SECTION = 5
// From this many columns the cards sit two to a row: each half then still fits
// a title, the status line and the four actions without cutting the status short.
const TWO_COLUMNS_FROM = 120
// A session idle this long has probably been forgotten, not just paused.
const SESSION_STALE_MS = 30 * 60 * 1000

const SECTIONS: { source: TrackerSource; title: string }[] = [
  { source: 'slack', title: 'Slack' },
  { source: 'pr', title: 'Pull requests' },
  { source: 'linear', title: 'Linear' },
  { source: 'jira', title: 'Jira' },
  { source: 'session', title: 'Claude sessions' },
]

const items = atom({ plugin: 'tracker', key: 'items' } as const, {})
const connected = atom({ plugin: 'tracker', key: 'connected' } as const, {})
const errors = atom({ plugin: 'tracker', key: 'errors' } as const, {})
const dismissed = atom({ plugin: 'tracker', key: 'dismissed' } as const, {})
const refreshedAt = atom({ plugin: 'tracker', key: 'refreshedAt' } as const, 0)
const isBusy = atom({ plugin: 'tracker', key: 'isBusy' } as const, false)
const expanded = atom({ plugin: 'tracker', key: 'expanded' } as const, {})
const doneLog = atom({ plugin: 'tracker', key: 'doneLog' } as const, {})
const urgent = atom({ plugin: 'tracker', key: 'urgent' } as const, {})
const filter = atom({ plugin: 'tracker', key: 'filter' } as const, 'all')
const query = atom({ plugin: 'tracker', key: 'query' } as const, '')
// The channels Slack mentions and threads come from, by id; DMs from people always count.
const DEFAULT_CHANNELS: Record<string, string> = {}
const channels = atom({ plugin: 'tracker', key: 'channels' } as const, DEFAULT_CHANNELS)
const channelNote = atom({ plugin: 'tracker', key: 'channelNote' } as const, '')
const editingChannels = atom({ plugin: 'tracker', key: 'editingChannels' } as const, false)

type $ = EngineInterface

async function settle($: $, source: TrackerSource, load: () => Promise<TrackerItem[]>) {
  try {
    const found = (await load()).sort((a, b) => b.at - a.at)
    await update($, items, all => ({ ...all, [source]: found }))
    await update($, errors, all => ({ ...all, [source]: '' }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, errors, all => ({ ...all, [source]: message.slice(0, 160) }))
  }
}

const PRIORITY_TONE: Record<number, TrackerTone> = { 1: 'error', 2: 'warning' }

async function loadLinear($: $, server: string): Promise<TrackerItem[]> {
  type Issue = {
    id: string
    title: string
    url: string
    status: string
    priority?: { value: number; name: string }
    updatedAt: string
  }
  // Linear filters by state server side: one 100-issue list of everything timed out, two small active lists don't.
  const byState = async (state: string) => {
    const result = await $.mcp.call(server, 'list_issues', {
      assignee: 'me',
      state,
      limit: 50,
      fields: ['id', 'title', 'url', 'status', 'priority', 'updatedAt'],
    })
    if (result.isError) throw new Error('Linear did not answer')
    return (mcpJson(result.content) as { issues: Issue[] }).issues
  }
  const issues = (await Promise.all([byState('started'), byState('unstarted')])).flat()

  return issues
    .map(issue => {
      const priority = issue.priority?.value ?? 0

      return {
        id: `linear:${issue.id}`,
        source: 'linear' as const,
        title: `${issue.id} ${issue.title}`,
        status: issue.status,
        tone: PRIORITY_TONE[priority] ?? 'subtle',
        detail: priority ? `${issue.priority!.name} priority` : '',
        url: issue.url,
        prompt: `Work on the Linear issue ${issue.id}: ${issue.title}`,
        stamp: issue.updatedAt,
        // Urgent first, then by last update: priority 0 is "none" and sorts last.
        at: Date.parse(issue.updatedAt) - ((priority || 5) - 1) * 1e12,
        when: Date.parse(issue.updatedAt),
      }
    })
}

const JIRA_TONE: Record<number, TrackerTone> = { 1: 'error', 2: 'warning' }

async function loadJira($: $, server: string): Promise<TrackerItem[]> {
  const resources = await $.mcp.call(server, 'getAccessibleAtlassianResources', {})
  if (resources.isError) throw new Error('Atlassian did not answer')
  const sites = (mcpJson(resources.content) as { id: string; url: string; scopes?: string[] }[]).filter(
    site => site.scopes === undefined || site.scopes.some(scope => scope.includes('jira')),
  )

  const perSite = await Promise.all(
    sites.map(async site => {
      const result = await $.mcp.call(server, 'searchJiraIssuesUsingJql', {
        cloudId: site.id,
        jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
        fields: ['summary', 'status', 'priority', 'updated'],
        maxResults: 50,
      })
      if (result.isError) throw new Error('Jira search did not answer')

      return jiraIssues(mcpJson(result.content)).map(issue => {
        const priority = issue.fields?.priority?.name
        const rank = jiraRank(priority)
        const updated = Date.parse(issue.fields?.updated ?? '') || 0
        const summary = issue.fields?.summary ?? ''

        return {
          id: `jira:${site.id}:${issue.key}`,
          source: 'jira' as const,
          title: `${issue.key} ${summary}`,
          status: issue.fields?.status?.name ?? 'open',
          tone: JIRA_TONE[rank] ?? 'subtle',
          detail: priority ? `${priority} priority` : '',
          url: `${site.url.replace(/\/$/, '')}/browse/${issue.key}`,
          prompt: `Work on the Jira issue ${issue.key}: ${summary}`,
          stamp: issue.fields?.updated ?? '',
          // Highest first, then by last update, as Linear sorts.
          at: updated - (rank - 1) * 1e12,
          when: updated,
        }
      })
    }),
  )

  return perSite.flat()
}

/** Whether `gh` is installed and signed in; PRs come from it, not from an MCP server. */
async function hasGh($: $): Promise<boolean> {
  try {
    return (await $.process.run(['gh', 'auth', 'status'])).exitCode === 0
  } catch {
    return false
  }
}

async function loadPrs($: $): Promise<TrackerItem[]> {
  const mine = await $.process.run([
    'gh', 'pr', 'list', '--author', '@me', '--state', 'open',
    '--json', 'number,title,url,isDraft,reviewDecision,updatedAt,statusCheckRollup',
  ])
  if (mine.exitCode !== 0) throw new Error(mine.stderr.trim() || 'gh pr list failed')
  const asked = await $.process.run([
    'gh', 'search', 'prs', '--review-requested=@me', '--state=open',
    '--json', 'number,title,url,updatedAt,repository,author', '--limit', '30',
  ])

  const own = (JSON.parse(mine.stdout) as PullRequest[]).map(pr => {
    const status = prStatus(pr)

    return {
      id: `pr:${pr.url}`,
      source: 'pr' as const,
      title: `#${pr.number} ${pr.title}`,
      status,
      tone: prTone(status),
      detail: 'Your PR',
      url: pr.url,
      prompt:
        status === 'approved, ready to merge'
          ? `PR ${pr.url} shows as approved. Confirm reviewDecision and CI, then merge it.`
          : `Get ${pr.url} ready to merge: fix its failing checks and answer its review comments.`,
      stamp: `${pr.updatedAt}|${status}`,
      at: Date.parse(pr.updatedAt),
      when: Date.parse(pr.updatedAt),
    }
  })
  const reviews =
    asked.exitCode === 0
      ? (JSON.parse(asked.stdout) as PullRequest[]).map(pr => ({
          id: `pr:${pr.url}`,
          source: 'pr' as const,
          title: `#${pr.number} ${pr.title}`,
          status: 'review requested',
          tone: 'claude' as const,
          detail: [pr.author?.login ? `Asked by ${pr.author.login}` : '', pr.repository?.nameWithOwner ?? '']
            .filter(Boolean)
            .join(' · '),
          url: pr.url,
          prompt: `/code-review ${pr.url}`,
          stamp: pr.updatedAt,
          // Someone waiting on my review goes above my own PRs.
          at: Date.parse(pr.updatedAt) + 1e12,
          when: Date.parse(pr.updatedAt),
        }))
      : []

  return [...reviews, ...own]
}

async function slackSearch($: $, server: string, me: string, args: Record<string, unknown>): Promise<SlackHit[]> {
  const result = await $.mcp.call(server, 'slack_search_public_and_private', {
    sort: 'timestamp',
    limit: 20,
    include_context: false,
    natural_language_query: '',
    ...args,
  })
  if (result.isError) throw new Error('Slack search did not answer')

  // Bots repeat what the other sections already say (CI runs, Linear DMs); only people count.
  return parseSlackResults((mcpJson(result.content) as { results: string }).results, me).filter(hit => !hit.isBot)
}

async function slackUserId($: $): Promise<string> {
  const tool = (await $.tool.list()).find(t => t.name.endsWith('slack_search_public_and_private'))
  const id = tool?.description.match(/user_id is (U[A-Z0-9]+)/)?.[1]
  if (id === undefined) throw new Error('Slack is not connected')

  return id
}

async function loadSlack($: $, server: string): Promise<TrackerItem[]> {
  const me = await slackUserId($)
  const watched = await read($, channels)
  const since = new Date(Date.now() - SLACK_DAYS * 864e5).toISOString().slice(0, 10)
  // A repeated `in:` is an OR, so one search covers every watched channel.
  const inWatched = Object.keys(watched).map(id => `in:<#${id}>`).join(' ')
  const [dms, mentions, myThreadReplies] = await Promise.all([
    slackSearch($, server, me, { filters: `is:dm after:${since}`, channel_types: 'im,mpim' }),
    inWatched ? slackSearch($, server, me, { keywords: [`<@${me}>`], filters: `${inWatched} after:${since}` }) : [],
    inWatched ? slackSearch($, server, me, { filters: `from:<@${me}> is:thread ${inWatched} after:${since}` }) : [],
  ])
  const found: TrackerItem[] = []
  const workspace = [...dms, ...mentions, ...myThreadReplies]
    .map(hit => hit.permalink.match(/^(https:\/\/[^/]+)/)?.[1])
    .find(Boolean)

  // A DM conversation waits on me when its newest message is someone else's.
  const newestPerConversation = new Map<string, SlackHit>()
  for (const hit of dms) {
    const key = `${hit.channel}|${hit.threadTs ?? ''}`
    if (!newestPerConversation.has(key)) newestPerConversation.set(key, hit)
  }
  for (const [key, hit] of newestPerConversation) {
    if (hit.fromId === me) continue
    found.push({
      id: `slack:${key}`,
      source: 'slack',
      title: readable(hit.text) || 'Sent you an attachment',
      status: hit.threadTs ? 'replied in a DM thread' : 'direct message',
      tone: 'claude',
      detail: `from ${hit.fromName}`,
      url: hit.permalink,
      prompt: `Help me reply to ${hit.fromName} on Slack. Read the conversation first: ${hit.permalink}`,
      stamp: hit.ts,
      at: Number(hit.ts) * 1000,
      when: Number(hit.ts) * 1000,
    })
  }

  // Mentions and threads I posted in wait on me when the thread's last word is someone else's.
  const threads = new Map<string, { channel: string; channelName: string; threadTs: string; why: string }>()
  for (const hit of mentions) {
    if (hit.isDm || hit.fromId === me || !(hit.channel in watched)) continue
    const threadTs = hit.threadTs ?? hit.ts
    threads.set(`${hit.channel}|${threadTs}`, { channel: hit.channel, channelName: hit.channelName, threadTs, why: 'mentioned you' })
  }
  for (const hit of myThreadReplies) {
    if (hit.isDm || hit.threadTs === undefined || !(hit.channel in watched)) continue
    const key = `${hit.channel}|${hit.threadTs}`
    if (!threads.has(key)) {
      threads.set(key, { channel: hit.channel, channelName: hit.channelName, threadTs: hit.threadTs, why: 'replied in your thread' })
    }
  }
  const checked = [...threads.entries()]
    .sort(([, a], [, b]) => Number(b.threadTs) - Number(a.threadTs))
    .slice(0, THREADS_CHECKED)
  for (let i = 0; i < checked.length; i += 4) {
    const batch = await Promise.all(
      checked.slice(i, i + 4).map(async ([key, thread]) => {
        const result = await $.mcp.call(server, 'slack_read_thread', {
          channel_id: thread.channel,
          message_ts: thread.threadTs,
        })
        if (result.isError) return undefined
        const last = parseThread((mcpJson(result.content) as { messages: string }).messages, me)
          .filter(message => !message.isBot)
          .at(-1)
        if (last === undefined || last.fromId === me) return undefined
        const url = workspace
          ? `${workspace}/archives/${thread.channel}/p${thread.threadTs.replace('.', '')}`
          : undefined

        return {
          id: `slack:${key}`,
          source: 'slack' as const,
          title: readable(last.text) || `${last.fromName} posted an attachment`,
          status: thread.why,
          tone: 'claude' as const,
          detail: `${last.fromName} in ${thread.channelName}`,
          url,
          prompt: `Help me reply to ${last.fromName} in ${thread.channelName} on Slack. Read the thread first${url ? `: ${url}` : '.'}`,
          stamp: last.ts,
          at: Number(last.ts) * 1000,
          when: Number(last.ts) * 1000,
        }
      }),
    )
    for (const item of batch) if (item) found.push(item)
  }

  return found
}

/** Looks a channel up by name and adds it to the watched set; a miss says so. */
async function watchChannel($: $, typed: string) {
  const name = typed.trim().replace(/^#/, '').toLowerCase()
  const server = (await read($, connected)).slack
  if (name === '' || server === undefined) return
  try {
    const result = await $.mcp.call(server, 'slack_search_channels', {
      keywords: [name],
      natural_language_query: name,
      channel_types: 'public_channel,private_channel',
      response_format: 'concise',
    })
    if (result.isError) throw new Error('Slack did not answer')
    const id = parseChannelList((mcpJson(result.content) as { results: string }).results)[name]
    if (id === undefined) {
      await update($, channelNote, () => `No channel named #${name}`)
      return
    }
    const next = await update($, channels, all => ({ ...all, [id]: `#${name}` }))
    await $.store.set('channels', next)
    await update($, channelNote, () => '')
    void settle($, 'slack', () => loadSlack($, server)).then(() => showCount($))
  } catch (error) {
    await update($, channelNote, () => (error instanceof Error ? error.message : String(error)))
  }
}

async function unwatchChannel($: $, id: string) {
  const next = await update($, channels, all => {
    const { [id]: _, ...rest } = all
    return rest
  })
  await $.store.set('channels', next)
  const server = (await read($, connected)).slack
  if (server !== undefined) void settle($, 'slack', () => loadSlack($, server)).then(() => showCount($))
}

async function loadSessions($: $): Promise<TrackerItem[]> {
  const home = await $.env.get('HOME')
  if (home === undefined) throw new Error('HOME is not set')
  const own = await $.session.id()
  const folder = `${home}/.claude/sessions`
  const entries = (await $.fs.list(folder)).filter(entry => entry.name.endsWith('.json'))
  const sessions = (
    await Promise.all(
      entries.map(async entry => {
        try {
          return JSON.parse(await $.fs.read(`${folder}/${entry.name}`)) as {
            pid: number
            sessionId: string
            cwd: string
            name?: string
            status?: string
            statusUpdatedAt?: number
          }
        } catch {
          return undefined
        }
      }),
    )
  ).filter(s => s !== undefined && s.sessionId !== own && s.status === 'idle')
  if (sessions.length === 0) return []

  // A registry file can outlive its process; keep the ones still running.
  const ps = await $.process.run(['ps', '-o', 'pid=', '-p', sessions.map(s => String(s!.pid)).join(',')])
  const alive = new Set(ps.stdout.split(/\s+/).filter(Boolean))
  const prompts = lastPrompts(await $.fs.read(`${home}/.claude/history.jsonl`).catch(() => ''))
  const now = Date.now()

  return sessions
    .filter(s => alive.has(String(s!.pid)))
    .map(s => {
      const session = s!
      const since = session.statusUpdatedAt ?? 0
      const name = session.name ?? session.sessionId.slice(0, 8)
      const last = prompts[session.sessionId]

      return {
        id: `session:${session.sessionId}`,
        source: 'session' as const,
        title: name,
        status: 'idle, waiting for you',
        tone: now - since > SESSION_STALE_MS ? ('warning' as const) : ('subtle' as const),
        detail: last ? `last asked: ${last.replace(/\s+/g, ' ')}` : `in ${session.cwd.split('/').at(-1) ?? ''}`,
        prompt: `Ask the Claude session "${name}" where it stands and what it needs from me.`,
        stamp: String(since),
        at: since,
        when: since,
      }
    })
}

async function refreshRemote($: $) {
  if (await read($, isBusy)) return
  await update($, isBusy, () => true)
  try {
    // Only what is connected now is asked; a source that went away drops its rows and error.
    const found: Record<string, string> = { ...detectSources(await $.tool.list()) }
    if (await hasGh($)) found.pr = 'gh'
    await update($, connected, () => found)
    const gone = SECTIONS.map(s => s.source).filter(source => source !== 'session' && !(source in found))
    await update($, items, all => ({ ...all, ...Object.fromEntries(gone.map(source => [source, []])) }))
    await update($, errors, all => ({ ...all, ...Object.fromEntries(gone.map(source => [source, ''])) }))

    const LOADERS: Partial<Record<TrackerSource, (server: string) => Promise<TrackerItem[]>>> = {
      slack: server => loadSlack($, server),
      pr: () => loadPrs($),
      linear: server => loadLinear($, server),
      jira: server => loadJira($, server),
    }
    await Promise.all([
      ...Object.entries(found).map(([source, server]) =>
        settle($, source as TrackerSource, () => LOADERS[source as TrackerSource]!(server)),
      ),
      settle($, 'session', () => loadSessions($)),
    ])
    await update($, refreshedAt, () => Date.now())
  } finally {
    await update($, isBusy, () => false)
  }
  await showCount($)
}

async function showCount($: $) {
  const all = Object.values(await read($, items)).flat()
  const count = visible(all, await read($, dismissed)).length
  $.ui.status(count > 0 ? `tracker ${count}` : undefined)
}

async function dismiss($: $, item: TrackerItem) {
  const before = await read($, dismissed)
  const next = await update($, dismissed, all => ({ ...all, [item.id]: item.stamp }))
  await $.store.set('dismissed', next)
  const log = await update($, doneLog, all => ({
    ...pruneDone(all, Date.now()),
    [item.id]: { item, at: Date.now(), previous: before[item.id] },
  }))
  await $.store.set('doneLog', log)
  await showCount($)
}

/** Puts a done row back where it came from and out of the Done tab. */
async function restore($: $, entry: TrackerDone) {
  const id = entry.item.id
  const next = await update($, dismissed, all => {
    const { [id]: _, ...rest } = all
    return entry.previous === undefined ? rest : { ...rest, [id]: entry.previous }
  })
  await $.store.set('dismissed', next)
  const log = await update($, doneLog, all => {
    const { [id]: _, ...rest } = all
    return rest
  })
  await $.store.set('doneLog', log)
  await showCount($)
}

/** A list as rows of two, the last row holding one when the count is odd. */
function pairs<T>(list: readonly T[]): [T, T | undefined][] {
  const rows: [T, T | undefined][] = []
  for (let i = 0; i < list.length; i += 2) rows.push([list[i]!, list[i + 1]])

  return rows
}

async function toggleUrgent($: $, item: TrackerItem) {
  const next = await update($, urgent, all => {
    const { [item.id]: was, ...rest } = all
    return was ? rest : { ...rest, [item.id]: true as const }
  })
  await $.store.set('urgent', next)
}

const TABS: { filter: TrackerFilter; title: string }[] = [
  { filter: 'all', title: 'All' },
  { filter: 'urgent', title: 'Urgent' },
  { filter: 'slack', title: 'Slack' },
  { filter: 'pr', title: 'PRs' },
  { filter: 'linear', title: 'Linear' },
  { filter: 'jira', title: 'Jira' },
  { filter: 'session', title: 'Sessions' },
  { filter: 'done', title: 'Done' },
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tracker',
      description: 'Show what is waiting on you in the tools you have connected, and your Claude sessions',
      argumentHint: '[refresh]',
    })
    const stored = (await $.store.get('dismissed')) as Record<string, string> | undefined
    if (stored) await update($, dismissed, () => stored)
    const flagged = (await $.store.get('urgent')) as Record<string, true> | undefined
    if (flagged) await update($, urgent, () => flagged)
    const watched = (await $.store.get('channels')) as Record<string, string> | undefined
    if (watched) await update($, channels, () => watched)
    const log = (await $.store.get('doneLog')) as Record<string, TrackerDone> | undefined
    if (log) await update($, doneLog, () => pruneDone(log, Date.now()))

    void refreshRemote($)
    $.clock.every(REMOTE_EVERY_MS, () => void refreshRemote($))
    $.clock.every(SESSIONS_EVERY_MS, () => void settle($, 'session', () => loadSessions($)).then(() => showCount($)))
    void $.ui.open({ id: PANE, title: 'Tracker' })

    return next(e)
  })

  on('command.run', { command: 'tracker' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Tracker' })
    if (e.args.trim() === 'refresh') void refreshRemote($)

    return { text: 'Tracker pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Mobile draws no text field, so search is left out there.
    const Input = 'Input' in ui ? ui.Input : undefined
    const all = await read($, items)
    const failed = await read($, errors)
    const live = await read($, connected)
    const hasSlack = live.slack !== undefined
    const hidden = await read($, dismissed)
    const busy = await read($, isBusy)
    const at = await read($, refreshedAt)
    const open = await read($, expanded)
    const log = await read($, doneLog)
    const flagged = await read($, urgent)
    const tab = await read($, filter)
    const search = (await read($, query)).trim()
    const watched = await read($, channels)
    const note = await read($, channelNote)
    const editing = await read($, editingChannels)
    const now = Date.now()
    const loading = at === 0
    const twoColumns = e.props.bodyColumns >= TWO_COLUMNS_FROM

    // Everything visible and matching the search, then split by tab.
    const pool = SECTIONS.flatMap(s => visible(all[s.source] ?? [], hidden)).filter(item => matches(item, search))
    const isUrgent = (item: TrackerItem) => flagged[item.id] === true
    // Pruned at draw time too, so a row leaves the tab at 48 hours without waiting for the next "done".
    const doneEntries = Object.values(pruneDone(log, now))
      .filter(entry => matches(entry.item, search))
      .sort((a, b) => b.at - a.at)
    const doneById = new Map(doneEntries.map(entry => [entry.item.id, entry]))
    const counts: Record<TrackerFilter, number> = {
      all: pool.length,
      urgent: pool.filter(isUrgent).length,
      done: doneEntries.length,
      slack: 0,
      pr: 0,
      linear: 0,
      jira: 0,
      session: 0,
    }
    for (const item of pool) counts[item.source] += 1

    // A section shows only when it has rows: no empty states. Slack's stays while its channels are edited.
    type Group = { key: string; title: string; tone?: TrackerTone; rows: TrackerItem[] }
    const groups: Group[] = []
    const urgentRows = pool.filter(isUrgent).sort((a, b) => b.at - a.at)
    if ((tab === 'all' || tab === 'urgent') && urgentRows.length > 0) {
      groups.push({ key: 'urgent', title: 'Urgent', tone: 'error', rows: urgentRows })
    }
    if (tab === 'done' && doneEntries.length > 0) {
      groups.push({ key: 'done', title: 'Done in the last 48 hours', tone: 'success', rows: doneEntries.map(d => d.item) })
    }
    for (const s of SECTIONS) {
      if (tab !== 'all' && tab !== s.source) continue
      const rows = pool.filter(item => item.source === s.source && (tab !== 'all' || !isUrgent(item)))
      rows.sort((a, b) => Number(isUrgent(b)) - Number(isUrgent(a)))
      if (rows.length > 0 || (s.source === 'slack' && hasSlack && editing)) groups.push({ key: s.source, title: s.title, rows })
    }
    // An empty tab is noise; All and the tab in use stay so the person never loses their place.
    const tabs = TABS.filter(t => t.filter === 'all' || t.filter === tab || counts[t.filter] > 0)
    // A connected source that failed is named once, quietly, at the foot; nothing else is said about it.
    const unreachable = SECTIONS.filter(s => s.source in live && failed[s.source]).map(s => s.title)

    const row = (item: TrackerItem, index: number) => {
      // A row in the Done tab is the snapshot "done" took; it offers restore instead of the triage buttons.
      const doneEntry = tab === 'done' ? doneById.get(item.id) : undefined
      // Scopes cap at 64 characters, so a row is named by position, not by its id.
      const scope = `${doneEntry ? 'done' : item.source}-${index}`
      const flag = !doneEntry && isUrgent(item)

      return (
        <Box
          key={item.id}
          flexDirection="column"
          paddingX={1}
          borderStyle="round"
          borderColor={flag ? 'error' : undefined}
          borderDimColor={!flag}
          hover={{ scope, borderColor: 'claude', borderDimColor: false }}
        >
          <Box flexDirection="row" gap={1}>
            <Text>{iconFor(item)}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end" bold={flag} dimColor={doneEntry !== undefined} hover={{ scope, color: 'claude' }}>
                {item.title}
              </Text>
            </Box>
            {doneEntry ? (
              <Text color="success">{`done ${ago(doneEntry.at, now)} ago`}</Text>
            ) : item.when > 0 ? (
              <Text dimColor>{`${ago(item.when, now)} ago`}</Text>
            ) : null}
          </Box>
          {/* Indented past the icon (two cells) and its gap, so status sits under the title. */}
          <Box flexDirection="row" gap={1} paddingLeft={3}>
            <Box flexGrow={1} flexShrink={1} flexDirection="row">
              <Text wrap="truncate-end">
                {flag ? <Text color="error" bold>{'Urgent · '}</Text> : ''}
                <Text color={doneEntry ? undefined : item.tone} dimColor={doneEntry !== undefined}>
                  {label(item.status)}
                </Text>
                {item.detail ? <Text dimColor>{` · ${item.detail}`}</Text> : ''}
              </Text>
            </Box>
            {item.prompt && !doneEntry ? (
              <Button key={`${item.id}:ask`} plain dimColor onPress={() => void $.prompt.fill({ text: item.prompt! })}>
                ask
              </Button>
            ) : null}
            {item.url ? (
              <Button key={`${item.id}:open`} plain dimColor onPress={() => void $.process.run(['open', item.url!])}>
                open
              </Button>
            ) : null}
            {doneEntry ? (
              <Button key={`${item.id}:restore`} plain dimColor onPress={() => void restore($, doneEntry)}>
                restore
              </Button>
            ) : (
              [
                <Button key={`${item.id}:urgent`} plain dimColor onPress={() => void toggleUrgent($, item)}>
                  {flag ? 'not urgent' : 'urgent'}
                </Button>,
                <Button key={`${item.id}:done`} plain dimColor onPress={() => void dismiss($, item)}>
                  done
                </Button>,
              ]
            )}
          </Box>
        </Box>
      )
    }

    const names = Object.values(watched)
    const channelBar = () => (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {names.length > 0 ? `DMs and ${names.join(', ')}` : 'DMs only: no channels watched'}
            </Text>
          </Box>
          <Button key="channels" plain dimColor onPress={() => void update($, editingChannels, open => !open)}>
            {editing ? 'close' : 'edit channels'}
          </Button>
        </Box>
        {editing ? (
          <Box flexDirection="column">
            {Object.entries(watched).map(([id, name]) => (
              <Box key={id} flexDirection="row" gap={1}>
                <Box flexGrow={1}>
                  <Text>{name}</Text>
                </Box>
                <Button key={`unwatch:${id}`} plain dimColor onPress={() => void unwatchChannel($, id)}>
                  remove
                </Button>
              </Box>
            ))}
            {Input ? (
              <Input
                key="add-channel"
                label="Add "
                placeholder="channel name, e.g. design"
                submitLabel="add"
                onSubmit={(value: string) => void watchChannel($, value)}
              />
            ) : null}
            {note ? <Text color="warning">{note}</Text> : null}
          </Box>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text>
            <Text bold>{`${TAB_ICONS.all} Tracker`}</Text>
            {pool.length > 0 ? <Text color="claude" bold>{` ${pool.length}`}</Text> : ''}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Text dimColor wrap="truncate-end">
              {busy ? 'Refreshing…' : loading ? 'Loading…' : `Updated ${ago(at, now)} ago`}
            </Text>
            <Button key="refresh" plain dimColor hotkey="r" onPress={() => void refreshRemote($)}>
              refresh
            </Button>
          </Box>
        </Box>

        <Box flexDirection="column">
          {Input ? (
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Input
                key="search"
                label="🔍 Search "
                placeholder="names, channels, branches, PR numbers"
                value={search}
                submitLabel="search"
                onInput={(value: string) => void update($, query, () => value)}
                onSubmit={(value: string) => void update($, query, () => value)}
              />
            </Box>
            {search ? (
              <Button key="clear" plain dimColor onPress={() => void update($, query, () => '')}>
                clear
              </Button>
            ) : null}
          </Box>
          ) : null}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {tabs.map(t =>
              // The tab in use is a filled pill; the rest are plain labels, no number prefix (per the Figma design).
              tab === t.filter ? (
                <Box key={`tab:${t.filter}`} paddingX={1} backgroundColor="claude">
                  <Text color="inverseText" bold>{`${TAB_ICONS[t.filter]} ${t.title} ${counts[t.filter]}`}</Text>
                </Box>
              ) : (
                <Box key={`tab:${t.filter}`} paddingX={1}>
                  <Button
                    key={`tab:${t.filter}`}
                    plain
                    dimColor
                    onPress={() => void update($, filter, () => t.filter)}
                  >
                    {`${TAB_ICONS[t.filter]} ${t.title} ${counts[t.filter]}`}
                  </Button>
                </Box>
              ),
            )}
          </Box>
        </Box>


        {!loading && search && pool.length === 0 ? (
          <Text dimColor>{`🔍 Nothing matches "${search}".`}</Text>
        ) : null}

        {groups.map(group => {
          const isOpen = open[group.key] === true || tab !== 'all'
          const list = isOpen ? group.rows : group.rows.slice(0, SHOWN_PER_SECTION)
          const more = group.rows.length - SHOWN_PER_SECTION

          return (
            <Box key={group.key} flexDirection="column">
              <Text>
                <Text bold color={group.tone}>{`${TAB_ICONS[group.key as TrackerFilter]} ${group.title}`}</Text>
                {group.rows.length > 0 ? <Text color="claude">{` ${group.rows.length}`}</Text> : ''}
              </Text>
              {group.key === 'slack' ? channelBar() : null}
              <Box flexDirection="column">
                {twoColumns
                  ? pairs(list).map(([left, right], index) => (
                      <Box key={`${group.key}:pair:${index}`} flexDirection="row">
                        <Box width="50%">{row(left, index * 2)}</Box>
                        {/* An empty half keeps a lone last card at half width, in line with the column above it. */}
                        <Box width="50%">{right ? row(right, index * 2 + 1) : null}</Box>
                      </Box>
                    ))
                  : list.map(row)}
              </Box>
              {tab === 'all' && more > 0 ? (
                <Box paddingLeft={1}>
                  <Button
                    key={`${group.key}:more`}
                    plain
                    dimColor
                    onPress={() => void update($, expanded, all => ({ ...all, [group.key]: !isOpen }))}
                  >
                    {isOpen ? 'Show less' : `Show ${more} more`}
                  </Button>
                </Box>
              ) : null}
            </Box>
          )
        })}

        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {unreachable.length > 0 ? `r refresh · couldn't reach ${unreachable.join(', ')}` : 'r refresh'}
            </Text>
          </Box>
          {hasSlack ? (
            <Button key="channels-footer" plain dimColor onPress={() => void update($, editingChannels, open => !open)}>
              {editing ? 'close channels' : 'Slack channels'}
            </Button>
          ) : null}
        </Box>
      </Box>
    )
  })
}

