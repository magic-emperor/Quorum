// ─── PM Adapter Interface ─────────────────────────────────────────────────────
// All PM tool integrations implement PMAdapter.
// This interface keeps the BA trigger flow (quorum watch) decoupled from
// any specific tool. New adapters slot in by implementing this interface.

export interface PMConfig {
  tool: PMTool
  baseUrl?: string          // e.g. "https://mycompany.atlassian.net"
  token: string             // API token / PAT
  projectKey?: string       // e.g. "MYAPP" for Jira, "PROJ" for Azure Boards
  teamId?: string           // Azure DevOps team ID
  workspaceId?: string      // Linear workspace ID
}

export type PMTool =
  | 'jira'
  | 'azure-boards'
  | 'github-issues'
  | 'linear'
  | 'asana'
  | 'monday'
  | 'clickup'
  | 'notion'
  | 'servicenow'
  | 'shortcut'

export type ATLASStatus = 'in_progress' | 'in_review' | 'done' | 'failed' | 'blocked'

export interface Ticket {
  id: string                // e.g. "PROJ-42", "#123"
  title: string
  description?: string
  acceptance_criteria: string[]
  url: string
  status: string            // native status from the tool
  assignee?: string
  labels?: string[]
}

// ─── Core interface ───────────────────────────────────────────────────────────

export interface PMAdapter {
  readonly name: PMTool

  /** Authenticate and verify the connection. Throws on failure. */
  connect(config: PMConfig): Promise<void>

  /** Fetch a single ticket by ID. */
  getTicket(ticketId: string): Promise<Ticket>

  /** Parse acceptance criteria from ticket description / custom fields. */
  getAcceptanceCriteria(ticketId: string): Promise<string[]>

  /** Watch for new/updated tickets matching a keyword. cb fires on each match. */
  watchForKeyword(keyword: string, cb: (ticket: Ticket) => void): Promise<() => void>

  /** Post a comment back to the ticket. */
  postComment(ticketId: string, message: string): Promise<void>

  /** Update ticket status to reflect QUORUM execution state. */
  updateStatus(ticketId: string, status: ATLASStatus): Promise<void>

  /** Link a PR/branch to the ticket. */
  linkPR?(ticketId: string, prUrl: string, prTitle: string): Promise<void>
}

// ─── Jira adapter ────────────────────────────────────────────────────────────

export class JiraAdapter implements PMAdapter {
  readonly name: PMTool = 'jira'
  private config!: PMConfig

  async connect(config: PMConfig): Promise<void> {
    this.config = config
    const resp = await fetch(`${config.baseUrl}/rest/api/3/myself`, {
      headers: this.headers()
    })
    if (!resp.ok) throw new Error(`Jira auth failed: ${resp.status}`)
  }

  async getTicket(ticketId: string): Promise<Ticket> {
    const resp = await fetch(
      `${this.config.baseUrl}/rest/api/3/issue/${ticketId}`,
      { headers: this.headers() }
    )
    if (!resp.ok) throw new Error(`Jira getTicket ${ticketId}: ${resp.status}`)

    const data = await resp.json() as {
      key: string
      fields: {
        summary: string
        description?: { content?: Array<{ content?: Array<{ text?: string }> }> }
        status: { name: string }
        assignee?: { displayName: string }
        labels?: string[]
        customfield_10016?: string  // story points — varies by instance
      }
    }

    const description = extractJiraText(data.fields.description)
    const ac = extractAcceptanceCriteria(description)

    return {
      id: data.key,
      title: data.fields.summary,
      description,
      acceptance_criteria: ac,
      url: `${this.config.baseUrl}/browse/${data.key}`,
      status: data.fields.status.name,
      assignee: data.fields.assignee?.displayName,
      labels: data.fields.labels
    }
  }

  async getAcceptanceCriteria(ticketId: string): Promise<string[]> {
    const ticket = await this.getTicket(ticketId)
    return ticket.acceptance_criteria
  }

  async watchForKeyword(keyword: string, cb: (ticket: Ticket) => void): Promise<() => void> {
    const projectKey = this.config.projectKey ?? ''
    const jql = `project = "${projectKey}" AND text ~ "${keyword}" AND status = "To Do" ORDER BY created DESC`
    const seen = new Set<string>()

    const poll = async () => {
      try {
        const resp = await fetch(
          `${this.config.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=10`,
          { headers: this.headers() }
        )
        if (!resp.ok) return
        const data = await resp.json() as { issues: Array<{ key: string }> }
        for (const issue of data.issues) {
          if (!seen.has(issue.key)) {
            seen.add(issue.key)
            const ticket = await this.getTicket(issue.key)
            cb(ticket)
          }
        }
      } catch {
        // polling continues even on transient errors
      }
    }

    await poll()
    const interval = setInterval(poll, 60_000)  // poll every minute
    return () => clearInterval(interval)
  }

  async postComment(ticketId: string, message: string): Promise<void> {
    await fetch(
      `${this.config.baseUrl}/rest/api/3/issue/${ticketId}/comment`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: message }] }] } })
      }
    )
  }

  async updateStatus(ticketId: string, status: ATLASStatus): Promise<void> {
    // Map QUORUM status to Jira transition name
    const transitionName = jiraTransition(status)

    // Get available transitions
    const resp = await fetch(
      `${this.config.baseUrl}/rest/api/3/issue/${ticketId}/transitions`,
      { headers: this.headers() }
    )
    if (!resp.ok) return

    const data = await resp.json() as { transitions: Array<{ id: string; name: string }> }
    const transition = data.transitions.find(t => t.name.toLowerCase().includes(transitionName.toLowerCase()))
    if (!transition) return

    await fetch(
      `${this.config.baseUrl}/rest/api/3/issue/${ticketId}/transitions`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ transition: { id: transition.id } })
      }
    )
  }

  async linkPR(ticketId: string, prUrl: string, prTitle: string): Promise<void> {
    await this.postComment(ticketId, `PR opened: [${prTitle}](${prUrl})`)
  }

  private headers() {
    const creds = Buffer.from(`quorum:${this.config.token}`).toString('base64')
    return {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  }
}

// ─── Linear adapter ───────────────────────────────────────────────────────────

export class LinearAdapter implements PMAdapter {
  readonly name: PMTool = 'linear'
  private config!: PMConfig

  async connect(config: PMConfig): Promise<void> {
    this.config = config
    const resp = await this.gql('{ viewer { id name } }')
    if (!resp.data) throw new Error('Linear auth failed')
  }

  async getTicket(ticketId: string): Promise<Ticket> {
    const data = await this.gql(`
      query {
        issue(id: "${ticketId}") {
          id identifier title description
          state { name }
          assignee { name }
          labels { nodes { name } }
          url
        }
      }
    `)

    type LinearIssue = {
      id: string; identifier: string; title: string; description?: string; url: string
      state: { name: string }; assignee?: { name: string }
      labels?: { nodes?: Array<{ name: string }> }
    }
    const issue = data.data?.['issue'] as LinearIssue | undefined
    if (!issue) throw new Error(`Linear issue ${ticketId} not found`)

    const ac = extractAcceptanceCriteria(issue.description ?? '')

    return {
      id: issue.identifier,
      title: issue.title,
      description: issue.description,
      acceptance_criteria: ac,
      url: issue.url,
      status: issue.state.name,
      assignee: issue.assignee?.name,
      labels: issue.labels?.nodes?.map((l) => l.name)
    }
  }

  async getAcceptanceCriteria(ticketId: string): Promise<string[]> {
    const ticket = await this.getTicket(ticketId)
    return ticket.acceptance_criteria
  }

  async watchForKeyword(keyword: string, cb: (ticket: Ticket) => void): Promise<() => void> {
    const seen = new Set<string>()

    const poll = async () => {
      try {
        const data = await this.gql(`
          query {
            issues(filter: { title: { containsIgnoreCase: "${keyword}" }, state: { type: { eq: "unstarted" } } }, first: 10) {
              nodes { id identifier }
            }
          }
        `)
        type LinearIssueRef = { id: string; identifier: string }
        const issues = (data.data?.['issues'] as { nodes?: LinearIssueRef[] } | undefined)?.nodes ?? []
        for (const issue of issues) {
          if (!seen.has(issue.identifier)) {
            seen.add(issue.identifier)
            const ticket = await this.getTicket(issue.identifier)
            cb(ticket)
          }
        }
      } catch {
        // continue polling
      }
    }

    await poll()
    const interval = setInterval(poll, 60_000)
    return () => clearInterval(interval)
  }

  async postComment(ticketId: string, message: string): Promise<void> {
    const ticket = await this.getTicket(ticketId)
    await this.gql(`
      mutation {
        commentCreate(input: { issueId: "${ticket.id}", body: "${message.replace(/"/g, '\\"')}" }) {
          success
        }
      }
    `)
  }

  async updateStatus(ticketId: string, status: ATLASStatus): Promise<void> {
    // Linear uses state IDs — get the state that matches
    const stateName = linearState(status)
    const data = await this.gql(`
      query {
        workflowStates(filter: { name: { containsIgnoreCase: "${stateName}" } }, first: 1) {
          nodes { id name }
        }
      }
    `)
    type LinearState = { id: string; name: string }
    const state = ((data.data?.['workflowStates'] as { nodes?: LinearState[] } | undefined)?.nodes ?? [])[0]
    if (!state) return

    const ticket = await this.getTicket(ticketId)
    await this.gql(`
      mutation {
        issueUpdate(id: "${ticket.id}", input: { stateId: "${state.id}" }) {
          success
        }
      }
    `)
  }

  private async gql(query: string): Promise<{ data?: Record<string, unknown> }> {
    const resp = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Authorization': this.config.token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    })
    return resp.json() as Promise<{ data?: Record<string, unknown> }>
  }
}

// ─── GitHub Issues adapter ────────────────────────────────────────────────────

export class GitHubIssuesAdapter implements PMAdapter {
  readonly name: PMTool = 'github-issues'
  private config!: PMConfig
  private repoOwner = ''
  private repoName = ''

  async connect(config: PMConfig): Promise<void> {
    this.config = config
    // baseUrl expected as "owner/repo" or full GitHub URL
    const parts = (config.baseUrl ?? '').replace('https://github.com/', '').split('/')
    this.repoOwner = parts[0] ?? ''
    this.repoName = parts[1] ?? ''

    const resp = await fetch(`https://api.github.com/repos/${this.repoOwner}/${this.repoName}`, {
      headers: this.headers()
    })
    if (!resp.ok) throw new Error(`GitHub Issues auth failed: ${resp.status}`)
  }

  async getTicket(issueNumber: string): Promise<Ticket> {
    const resp = await fetch(
      `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/issues/${issueNumber}`,
      { headers: this.headers() }
    )
    if (!resp.ok) throw new Error(`GitHub issue #${issueNumber}: ${resp.status}`)

    const data = await resp.json() as {
      number: number
      title: string
      body?: string
      html_url: string
      state: string
      assignee?: { login: string }
      labels: Array<{ name: string }>
    }

    const ac = extractAcceptanceCriteria(data.body ?? '')

    return {
      id: `#${data.number}`,
      title: data.title,
      description: data.body,
      acceptance_criteria: ac,
      url: data.html_url,
      status: data.state,
      assignee: data.assignee?.login,
      labels: data.labels.map(l => l.name)
    }
  }

  async getAcceptanceCriteria(issueNumber: string): Promise<string[]> {
    const ticket = await this.getTicket(issueNumber)
    return ticket.acceptance_criteria
  }

  async watchForKeyword(keyword: string, cb: (ticket: Ticket) => void): Promise<() => void> {
    const seen = new Set<string>()

    const poll = async () => {
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/issues?state=open&per_page=20`,
          { headers: this.headers() }
        )
        if (!resp.ok) return
        const issues = await resp.json() as Array<{ number: number; title: string; body?: string }>
        for (const issue of issues) {
          const matches = (issue.title + ' ' + (issue.body ?? '')).toLowerCase().includes(keyword.toLowerCase())
          if (matches && !seen.has(String(issue.number))) {
            seen.add(String(issue.number))
            const ticket = await this.getTicket(String(issue.number))
            cb(ticket)
          }
        }
      } catch {
        // continue
      }
    }

    await poll()
    const interval = setInterval(poll, 60_000)
    return () => clearInterval(interval)
  }

  async postComment(issueNumber: string, message: string): Promise<void> {
    const num = issueNumber.replace('#', '')
    await fetch(
      `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/issues/${num}/comments`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ body: message })
      }
    )
  }

  async updateStatus(issueNumber: string, status: ATLASStatus): Promise<void> {
    const num = issueNumber.replace('#', '')
    const state = status === 'done' ? 'closed' : 'open'
    await fetch(
      `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/issues/${num}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ state })
      }
    )
  }

  private headers() {
    return {
      'Authorization': `token ${this.config.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    }
  }
}

// ─── Azure Boards adapter ─────────────────────────────────────────────────────
// Uses the Azure DevOps REST API (v7.1).
// config.baseUrl = "https://dev.azure.com/{organization}"
// config.projectKey = "{project}"
// config.teamId = optional team GUID
// config.token = Personal Access Token (Base64 encoded internally)

export class AzureBoardsAdapter implements PMAdapter {
  readonly name: PMTool = 'azure-boards'
  private config!: PMConfig
  private org = ''
  private project = ''

  async connect(config: PMConfig): Promise<void> {
    this.config = config
    // Parse org from baseUrl: "https://dev.azure.com/myorg" → "myorg"
    const url = new URL(config.baseUrl ?? 'https://dev.azure.com')
    this.org = url.pathname.replace(/^\//, '').split('/')[0] ?? ''
    this.project = config.projectKey ?? ''

    const resp = await fetch(
      `${this.base()}/_apis/projects/${this.project}?api-version=7.1`,
      { headers: this.headers() }
    )
    if (!resp.ok) throw new Error(`Azure Boards auth failed: ${resp.status} — check PAT and org/project`)
  }

  async getTicket(workItemId: string): Promise<Ticket> {
    const resp = await fetch(
      `${this.base()}/_apis/wit/workitems/${workItemId}?$expand=all&api-version=7.1`,
      { headers: this.headers() }
    )
    if (!resp.ok) throw new Error(`Azure Boards work item ${workItemId}: ${resp.status}`)

    const data = await resp.json() as {
      id: number
      fields: {
        'System.Title': string
        'System.Description'?: string
        'System.State': string
        'System.AssignedTo'?: { displayName: string }
        'Microsoft.VSTS.Common.AcceptanceCriteria'?: string
        'System.Tags'?: string
      }
      _links: { html: { href: string } }
    }

    const f = data.fields
    const description = stripHtml(f['System.Description'] ?? '')
    const acField = stripHtml(f['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? '')
    const ac = acField
      ? extractAcceptanceCriteria(acField)
      : extractAcceptanceCriteria(description)

    return {
      id: String(data.id),
      title: f['System.Title'],
      description,
      acceptance_criteria: ac,
      url: data._links.html.href,
      status: f['System.State'],
      assignee: f['System.AssignedTo']?.displayName,
      labels: f['System.Tags']?.split(';').map(t => t.trim()).filter(Boolean) ?? []
    }
  }

  async getAcceptanceCriteria(workItemId: string): Promise<string[]> {
    const ticket = await this.getTicket(workItemId)
    return ticket.acceptance_criteria
  }

  async watchForKeyword(keyword: string, cb: (ticket: Ticket) => void): Promise<() => void> {
    const seen = new Set<string>()

    // WIQL query — work items in Active/New state containing keyword
    const wiql = {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}' AND [System.Title] CONTAINS '${keyword}' AND [System.State] IN ('New','Active') ORDER BY [System.CreatedDate] DESC`
    }

    const poll = async () => {
      try {
        const resp = await fetch(
          `${this.base()}/_apis/wit/wiql?$top=20&api-version=7.1`,
          { method: 'POST', headers: this.headers(), body: JSON.stringify(wiql) }
        )
        if (!resp.ok) return

        const data = await resp.json() as { workItems: Array<{ id: number }> }
        for (const wi of data.workItems ?? []) {
          const id = String(wi.id)
          if (!seen.has(id)) {
            seen.add(id)
            const ticket = await this.getTicket(id)
            cb(ticket)
          }
        }
      } catch {
        // continue polling
      }
    }

    await poll()
    const interval = setInterval(poll, 60_000)
    return () => clearInterval(interval)
  }

  async postComment(workItemId: string, message: string): Promise<void> {
    await fetch(
      `${this.base()}/_apis/wit/workitems/${workItemId}/comments?api-version=7.1-preview.3`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ text: message })
      }
    )
  }

  async updateStatus(workItemId: string, status: ATLASStatus): Promise<void> {
    const state = azureState(status)
    await fetch(
      `${this.base()}/_apis/wit/workitems/${workItemId}?api-version=7.1`,
      {
        method: 'PATCH',
        headers: { ...this.headers(), 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([{ op: 'replace', path: '/fields/System.State', value: state }])
      }
    )
  }

  async linkPR(workItemId: string, prUrl: string, prTitle: string): Promise<void> {
    // Post as comment — full PR linking requires Azure DevOps Git integration
    await this.postComment(workItemId, `PR opened: [${prTitle}](${prUrl})`)
  }

  private base(): string {
    return `https://dev.azure.com/${this.org}/${this.project}`
  }

  private headers() {
    // Azure DevOps PAT: Basic auth with empty username
    const encoded = Buffer.from(`:${this.config.token}`).toString('base64')
    return {
      'Authorization': `Basic ${encoded}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createPMAdapter(tool: PMTool): PMAdapter {
  switch (tool) {
    case 'jira':          return new JiraAdapter()
    case 'linear':        return new LinearAdapter()
    case 'github-issues': return new GitHubIssuesAdapter()
    case 'azure-boards':  return new AzureBoardsAdapter()
    default:
      throw new Error(`PM adapter for "${tool}" not yet implemented. Available: jira, linear, github-issues, azure-boards`)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractJiraText(
  doc?: { content?: Array<{ content?: Array<{ text?: string }> }> }
): string {
  if (!doc) return ''
  return (doc.content ?? [])
    .flatMap(block => (block.content ?? []).map(n => n.text ?? ''))
    .join(' ')
    .trim()
}

function extractAcceptanceCriteria(text: string): string[] {
  if (!text) return []

  // Look for common AC section headers
  const acHeaderRegex = /(?:acceptance criteria|ac:|done when|definition of done|checklist)[:\s]*\n((?:[-*•\d]+[.)]\s*.+\n?)+)/gi
  const matches = [...text.matchAll(acHeaderRegex)]

  if (matches.length > 0) {
    return matches
      .flatMap(m => (m[1] ?? '').split('\n'))
      .map(line => line.replace(/^[-*•\d.)\s]+/, '').trim())
      .filter(Boolean)
  }

  // Fall back: any bullet list
  const bullets = text.match(/^[-*•]\s+.+$/gm) ?? []
  return bullets.map(b => b.replace(/^[-*•]\s+/, '').trim()).slice(0, 10)
}

function jiraTransition(status: ATLASStatus): string {
  const map: Record<ATLASStatus, string> = {
    in_progress: 'In Progress',
    in_review:   'In Review',
    done:        'Done',
    failed:      'Blocked',
    blocked:     'Blocked'
  }
  return map[status]
}

function linearState(status: ATLASStatus): string {
  const map: Record<ATLASStatus, string> = {
    in_progress: 'In Progress',
    in_review:   'In Review',
    done:        'Done',
    failed:      'Cancelled',
    blocked:     'Blocked'
  }
  return map[status]
}

function azureState(status: ATLASStatus): string {
  const map: Record<ATLASStatus, string> = {
    in_progress: 'Active',
    in_review:   'In Review',
    done:        'Closed',
    failed:      'Resolved',
    blocked:     'Active'
  }
  return map[status]
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
