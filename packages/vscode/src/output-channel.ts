import * as vscode from 'vscode'

/**
 * Manages the ATLAS output channel — the dedicted panel where all
 * agent output, progress messages, and session logs appear.
 */
export class ATLASOutputChannel {
  private channel: vscode.OutputChannel

  constructor() {
    this.channel = vscode.window.createOutputChannel('ATLAS')
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
    this.channel.appendLine(`  ATLAS — ${title}`)
    this.channel.appendLine(`  ══════════════════════════════════════`)
  }

  clear(): void {
    this.channel.clear()
  }

  dispose(): void {
    this.channel.dispose()
  }
}
