import * as vscode from 'vscode'

/**
 * Persistent status bar item showing ATLAS state at a glance.
 * Shows: session state, active provider, current command.
 */
export class ATLASStatusBar {
  private item: vscode.StatusBarItem

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    )
    this.item.command = 'atlas.showPanel'
    this.setIdle()
    this.item.show()
  }

  setIdle(): void {
    this.item.text = '$(robot) ATLAS'
    this.item.tooltip = 'ATLAS — Click to open panel'
    this.item.backgroundColor = undefined
  }

  setRunning(command: string): void {
    this.item.text = `$(sync~spin) ATLAS: ${command}`
    this.item.tooltip = `Running: atlas ${command}`
  }

  setComplete(command: string): void {
    this.item.text = `$(check) ATLAS: ${command} done`
    this.item.tooltip = `Completed: atlas ${command}`
    setTimeout(() => this.setIdle(), 3000)
  }

  setError(message: string): void {
    this.item.text = `$(error) ATLAS: error`
    this.item.tooltip = message
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
    setTimeout(() => {
      this.item.backgroundColor = undefined
      this.setIdle()
    }, 5000)
  }

  setProvider(providers: string[]): void {
    const label = providers.length > 0 ? providers.join('+') : 'no provider'
    this.item.text = `$(robot) ATLAS [${label}]`
    this.item.tooltip = `ATLAS — Providers: ${label}`
  }

  dispose(): void {
    this.item.dispose()
  }
}
