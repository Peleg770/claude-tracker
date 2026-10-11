export type TrackerSource = 'slack' | 'pr' | 'linear' | 'jira' | 'session'

export type TrackerFilter = 'all' | 'urgent' | 'done' | TrackerSource

/** The theme key a row's status word is drawn in. */
export type TrackerTone = 'error' | 'warning' | 'success' | 'claude' | 'subtle'

export type TrackerItem = {
  /** Stable across refreshes: `<source>:<key>`. */
  id: string
  source: TrackerSource
  title: string
  /** The short state word drawn in its tone at the start of the second line. */
  status: string
  tone: TrackerTone
  /** Dim context after the status: channel, author, last prompt. */
  detail: string
  /** Opened with the system's `open`. */
  url?: string
  /** What "ask" puts in the prompt box. */
  prompt?: string
  /** Changes when the item changes; "done" hides the item until it does. */
  stamp: string
  /** Sort key, newest or most urgent first within a section. */
  at: number
  /** Epoch ms the row's age is measured from. */
  when: number
}

export type TrackerDone = { item: TrackerItem; at: number; previous?: string }

declare module 'claude-code' {
  interface PluginState {
    tracker: {
      items: Record<string, TrackerItem[]>
      /** The sources found connected at the last refresh: source to the MCP server it reads (`gh` for PRs). */
      connected: Record<string, string>
      errors: Record<string, string>
      dismissed: Record<string, string>
      refreshedAt: number
      isBusy: boolean
      expanded: Record<string, boolean>
      /** What "done" hid, by id: the row as it was, when, and the stamp it replaced. Kept 48 hours. */
      doneLog: Record<string, TrackerDone>
      /** Ids marked urgent; kept across sessions in the store. */
      urgent: Record<string, true>
      /** Which tab the pane shows: `all`, `urgent` or one source. */
      filter: TrackerFilter
      query: string
      /** Watched Slack channels, id to `#name`; kept across sessions in the store. */
      channels: Record<string, string>
      /** Why the last "add channel" did not add one, or empty. */
      channelNote: string
      editingChannels: boolean
    }
  }
}

