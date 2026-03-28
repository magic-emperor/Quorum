import * as vscode from 'vscode'

/**
 * Persistent status bar item showing QUORUM state at a glance.
 * Shows: session state, active provider, current command.
 */
export class QUORUMStatusBar {
  private item: vscode.StatusBarItem

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    )
    this.item.command = 'quorum.showPanel'
    this.setIdle()
    this.item.show()
  }

  setIdle(): void {
    this.item.text = '$(robot) QUORUM'
    this.item.tooltip = 'QUORUM — Click to open panel'
    this.item.backgroundColor = undefined
  }

  setRunning(command: string): void {
    this.item.text = `$(sync~spin) QUORUM: ${command}`
    this.item.tooltip = `Running: quorum ${command}`
  }

  setComplete(command: string): void {
    this.item.text = `$(check) QUORUM: ${command} done`
    this.item.tooltip = `Completed: quorum ${command}`
    setTimeout(() => this.setIdle(), 3000)
  }

  setError(message: string): void {
    this.item.text = `$(error) QUORUM: error`
    this.item.tooltip = message
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
    setTimeout(() => {
      this.item.backgroundColor = undefined
      this.setIdle()
    }, 5000)
  }

  setProvider(providers: string[]): void {
    const label = providers.length > 0 ? providers.join('+') : 'no provider'
    this.item.text = `$(robot) QUORUM [${label}]`
    this.item.tooltip = `QUORUM — Providers: ${label}`
  }

  dispose(): void {
    this.item.dispose()
  }
}
