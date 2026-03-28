import * as vscode from 'vscode'

/**
 * Manages the QUORUM output channel — the dedicted panel where all
 * agent output, progress messages, and session logs appear.
 */
export class QUORUMOutputChannel {
  private channel: vscode.OutputChannel

  constructor() {
    this.channel = vscode.window.createOutputChannel('QUORUM')
  }

  get raw(): vscode.OutputChannel {
    return this.channel
  }

  show(preserveFocus = true): void {
    this.channel.show(preserveFocus)
  }

  appendLine(message: string): void {
    this.channel.appendLine(message)
  }

  header(title: string): void {
    this.channel.appendLine('')
    this.channel.appendLine(`  ══════════════════════════════════════`)
    this.channel.appendLine(`  QUORUM — ${title}`)
    this.channel.appendLine(`  ══════════════════════════════════════`)
  }

  clear(): void {
    this.channel.clear()
  }

  dispose(): void {
    this.channel.dispose()
  }
}
