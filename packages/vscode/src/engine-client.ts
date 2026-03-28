import * as vscode from 'vscode'
import { QUORUMEngine } from '@quorum/core'
import type { QUORUMRunOptions } from '@quorum/core'

/**
 * Wraps QUORUMEngine for use in the VS Code extension host.
 * Bridges VS Code APIs (workspace, progress, input boxes) with the core engine.
 */
export class EngineClient {
  private engine: QUORUMEngine | null = null

  constructor(
    private readonly projectDir: string,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  private getEngine(): QUORUMEngine {
    if (!this.engine) {
      this.engine = new QUORUMEngine({ projectDir: this.projectDir })
    }
    return this.engine
  }

  reset(): void {
    this.engine = null
  }

  async run(
    command: QUORUMRunOptions['command'],
    opts: {
      description?: string
      auto?: boolean
      extra?: Record<string, string>
      subcommand?: string
    } = {}
  ): Promise<void> {
    const engine = this.getEngine()
    const channel = this.outputChannel
    channel.show(true)

    const options: QUORUMRunOptions = {
      command,
      projectDir: this.projectDir,
      description: opts.description,
      auto: opts.auto,
      extra: opts.extra,
      subcommand: opts.subcommand,

      onProgress: (msg: string) => {
        channel.appendLine(msg)
      },

      onAgentOutput: (agent: string, output: string) => {
        channel.appendLine(`\n[${agent}]`)
        channel.appendLine(output)
        channel.appendLine('')
      },

      onCheckpoint: async (checkpoint) => {
        // Show checkpoint as VS Code input box
        const items = checkpoint.options.map(o => ({
          label: o.label,
          description: o.tradeoff
        }))

        const picked = await vscode.window.showQuickPick(items, {
          title: `QUORUM Checkpoint: ${checkpoint.title}`,
          placeHolder: checkpoint.question,
          ignoreFocusOut: true
        })

        return picked?.label ?? 'APPROVE'
      }
    }

    await engine.run(options)
  }
}
