import * as vscode from 'vscode'
import * as path from 'path'
import { QUORUMOutputChannel } from './output-channel'
import { QUORUMStatusBar } from './status-bar'
import { QUORUMPanelProvider } from './panel'
import { EngineClient } from './engine-client'

let outputChannel: QUORUMOutputChannel | undefined
let statusBar: QUORUMStatusBar | undefined
let panelProvider: QUORUMPanelProvider | undefined
let engineClient: EngineClient | undefined

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getProjectDir(): string {
  const cfg = vscode.workspace.getConfiguration('quorum')
  const override = cfg.get<string>('projectDir')
  if (override) return override
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
}

function getEngine(): EngineClient {
  if (!engineClient) {
    engineClient = new EngineClient(getProjectDir(), outputChannel!.raw)
  }
  return engineClient
}

/** Prompt for description, run command, update status bar and panel */
async function runWithPrompt(
  command: string,
  promptText: string,
  opts: { needsDescription?: boolean; subcommand?: string } = {}
): Promise<void> {
  let description: string | undefined

  if (opts.needsDescription) {
    description = await vscode.window.showInputBox({
      title: `QUORUM: ${command}`,
      prompt: promptText,
      ignoreFocusOut: true,
      placeHolder: promptText
    })
    if (description === undefined) return // user cancelled
  }

  const engine = getEngine()
  statusBar?.setRunning(command)
  outputChannel?.header(command.toUpperCase())

  try {
    await engine.run(command as Parameters<typeof engine.run>[0], {
      description,
      subcommand: opts.subcommand
    })
    statusBar?.setComplete(command)
    panelProvider?.refresh()
    panelProvider?.postMessage({ type: 'done' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    statusBar?.setError(msg)
    outputChannel?.appendLine(`\n✗ Error: ${msg}`)
    void vscode.window.showErrorMessage(`QUORUM ${command} failed: ${msg}`)
  }
}

// ─── Activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const projectDir = getProjectDir()

  // Core services
  outputChannel = new QUORUMOutputChannel()
  statusBar = new QUORUMStatusBar()
  panelProvider = new QUORUMPanelProvider(context.extensionUri, projectDir)

  // Wire panel command handler (messages from the webview button clicks)
  panelProvider.onCommand(async (command, description, _subcommand) => {
    if (command === '__refresh__') {
      panelProvider?.refresh()
      return
    }
    // Webview asks us to prompt (description === '__prompt__:...')
    if (description?.startsWith('__prompt__:')) {
      const placeholder = description.slice('__prompt__:'.length)
      await runWithPrompt(command, placeholder, { needsDescription: true })
    } else {
      await runWithPrompt(command, '', { needsDescription: false })
    }
  })

  // Register sidebar panel
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QUORUMPanelProvider.viewId, panelProvider)
  )

  // ─── Register all 24 commands ──────────────────────────────────────────────

  const cmds: Array<[string, () => Promise<void>]> = [

    ['quorum.new', () => runWithPrompt('new',
      'Describe what to build', { needsDescription: true })],

    ['quorum.enhance', () => runWithPrompt('enhance',
      'What do you want to enhance?', { needsDescription: true })],

    ['quorum.fast', () => runWithPrompt('fast',
      'Quick task (< 5 files)', { needsDescription: true })],

    ['quorum.next', () => runWithPrompt('next', '')],

    ['quorum.init', () => runWithPrompt('init', '')],

    ['quorum.doctor', () => runWithPrompt('doctor', '')],

    ['quorum.status', () => runWithPrompt('status', '')],

    ['quorum.discuss', () => runWithPrompt('discuss',
      'What feature do you want to discuss?', { needsDescription: true })],

    ['quorum.verify', () => runWithPrompt('verify', '')],

    ['quorum.ship', async () => {
      const draft = await vscode.window.showQuickPick(
        [{ label: 'Create PR', description: 'Open for review' },
         { label: 'Create draft PR', description: 'Mark as draft' }],
        { title: 'QUORUM: Ship', placeHolder: 'Select PR type' }
      )
      if (!draft) return
      const isDraft = draft.label.includes('draft')
      const engine = getEngine()
      statusBar?.setRunning('ship')
      outputChannel?.header('SHIP')
      try {
        await engine.run('ship', { extra: { draft: String(isDraft) } })
        statusBar?.setComplete('ship')
      } catch (err) {
        statusBar?.setError(err instanceof Error ? err.message : String(err))
      }
    }],

    ['quorum.review', async () => {
      const filePath = vscode.window.activeTextEditor?.document.uri.fsPath
      const reviewPath = filePath
        ? path.relative(getProjectDir(), filePath)
        : undefined
      const engine = getEngine()
      statusBar?.setRunning('review')
      outputChannel?.header('REVIEW')
      try {
        await engine.run('review', { description: reviewPath })
        statusBar?.setComplete('review')
      } catch (err) {
        statusBar?.setError(err instanceof Error ? err.message : String(err))
      }
    }],

    ['quorum.map', () => runWithPrompt('map', '')],

    ['quorum.debug', () => runWithPrompt('debug',
      'Describe the bug or error', { needsDescription: true })],

    ['quorum.sessionReport', () => runWithPrompt('session-report', '')],

    ['quorum.pause', () => runWithPrompt('pause', '')],

    ['quorum.resume', () => runWithPrompt('resume', '')],

    ['quorum.sync', () => runWithPrompt('sync', '')],

    ['quorum.rollback', async () => {
      const point = await vscode.window.showInputBox({
        title: 'QUORUM: Rollback',
        prompt: 'Rollback point ID (leave empty to list available points)',
        placeHolder: 'rp_001_architecture_approved',
        ignoreFocusOut: true
      })
      const engine = getEngine()
      statusBar?.setRunning('rollback')
      outputChannel?.header('ROLLBACK')
      try {
        await engine.run('rollback', {
          description: point || undefined,
          extra: { list: point ? 'false' : 'true' }
        })
        statusBar?.setComplete('rollback')
      } catch (err) {
        statusBar?.setError(err instanceof Error ? err.message : String(err))
      }
    }],

    ['quorum.agents', () => runWithPrompt('agents', '')],

    ['quorum.profile', async () => {
      const profile = await vscode.window.showQuickPick(
        [{ label: 'fast',      description: 'Groq/fast models — cheap, quick' },
         { label: 'balanced',  description: 'Mixed — default' },
         { label: 'quality',   description: 'Best models — Claude/GPT-4o' }],
        { title: 'QUORUM: Switch Profile', placeHolder: 'Select model quality tier' }
      )
      if (!profile) return
      const engine = getEngine()
      statusBar?.setRunning('profile')
      outputChannel?.header('PROFILE')
      try {
        await engine.run('profile', { description: profile.label })
        statusBar?.setComplete('profile')
      } catch (err) {
        statusBar?.setError(err instanceof Error ? err.message : String(err))
      }
    }],

    ['quorum.seed', () => runWithPrompt('seed',
      'What idea do you want to capture?', { needsDescription: true })],

    ['quorum.note', () => runWithPrompt('note',
      'Quick note text', { needsDescription: true })],

    ['quorum.backlog', async () => {
      const sub = await vscode.window.showQuickPick(
        [{ label: 'list', description: 'Show all backlog items' },
         { label: 'add',  description: 'Add a new backlog item' }],
        { title: 'QUORUM: Backlog' }
      )
      if (!sub) return
      let description: string | undefined
      if (sub.label === 'add') {
        description = await vscode.window.showInputBox({
          title: 'QUORUM: Backlog Add',
          prompt: 'What should be added to the backlog?',
          ignoreFocusOut: true
        })
        if (!description) return
      }
      const engine = getEngine()
      statusBar?.setRunning('backlog')
      outputChannel?.header('BACKLOG')
      try {
        await engine.run('backlog', { subcommand: sub.label, description })
        statusBar?.setComplete('backlog')
      } catch (err) {
        statusBar?.setError(err instanceof Error ? err.message : String(err))
      }
    }],

    ['quorum.showPanel', () => {
      void vscode.commands.executeCommand('quorum.panel.focus')
      return Promise.resolve()
    }]
  ]

  for (const [cmd, handler] of cmds) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, handler)
    )
  }

  // Push disposables
  context.subscriptions.push(
    { dispose: () => outputChannel?.dispose() },
    { dispose: () => statusBar?.dispose() }
  )

  // Auto-open panel if configured
  const cfg = vscode.workspace.getConfiguration('quorum')
  if (cfg.get<boolean>('autoOpen')) {
    void vscode.commands.executeCommand('quorum.panel.focus')
  }

  // Handle workspace folder changes — reset engine client
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      engineClient = undefined
      panelProvider?.refresh()
    })
  )

  outputChannel.appendLine('QUORUM extension activated.')
  outputChannel.appendLine(`Project: ${projectDir}`)
  outputChannel.appendLine('Run F1 → QUORUM: New Feature to get started.')
}

// ─── Deactivate ──────────────────────────────────────────────────────────────

export function deactivate(): void {
  engineClient = undefined
}
