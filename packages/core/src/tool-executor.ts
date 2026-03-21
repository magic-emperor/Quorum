import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { glob } from 'glob'
import path from 'path'
import type { ToolCall, ToolResult } from './types.js'

const execAsync = promisify(exec)

export class ToolExecutor {
  constructor(private projectDir: string) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.tool) {
        case 'file_read':   return await this.fileRead(call)
        case 'file_write':  return await this.fileWrite(call)
        case 'bash_exec':   return await this.bashExec(call)
        case 'glob_search': return await this.globSearch(call)
        case 'grep_search': return await this.grepSearch(call)
        default:
          return { success: false, output: '', error: `Unknown tool: ${(call as ToolCall).tool}` }
      }
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  private async fileRead(call: ToolCall): Promise<ToolResult> {
    if (!call.path) return { success: false, output: '', error: 'file_read requires path' }

    const fullPath = path.resolve(this.projectDir, call.path)

    if (!existsSync(fullPath)) {
      return { success: false, output: '', error: `File not found: ${call.path}` }
    }

    const content = await readFile(fullPath, 'utf-8')

    if (call.lines) {
      const parts = call.lines.split('-')
      const start = Math.max(0, parseInt(parts[0] ?? '1', 10) - 1)
      const end = parseInt(parts[1] ?? String(content.split('\n').length), 10)
      return { success: true, output: content.split('\n').slice(start, end).join('\n') }
    }

    return { success: true, output: content }
  }

  private async fileWrite(call: ToolCall): Promise<ToolResult> {
    if (!call.path || call.content === undefined) {
      return { success: false, output: '', error: 'file_write requires path and content' }
    }

    const fullPath = path.resolve(this.projectDir, call.path)
    await mkdir(path.dirname(fullPath), { recursive: true })

    if (call.mode === 'append') {
      const existing = existsSync(fullPath) ? await readFile(fullPath, 'utf-8') : ''
      await writeFile(fullPath, existing + call.content, 'utf-8')
    } else {
      await writeFile(fullPath, call.content, 'utf-8')
    }

    return { success: true, output: `Written: ${call.path}` }
  }

  private async bashExec(call: ToolCall): Promise<ToolResult> {
    if (!call.command) return { success: false, output: '', error: 'bash_exec requires command' }

    const { stdout, stderr } = await execAsync(call.command, {
      cwd: this.projectDir,
      timeout: 30_000
    })

    return {
      success: true,
      output: stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')
    }
  }

  private async globSearch(call: ToolCall): Promise<ToolResult> {
    if (!call.pattern) return { success: false, output: '', error: 'glob_search requires pattern' }

    const files = await glob(call.pattern, {
      cwd: this.projectDir,
      ignore: ['node_modules/**', '.git/**', 'dist/**'],
      absolute: false
    })

    const limited = call.max_results ? files.slice(0, call.max_results) : files
    return { success: true, output: limited.join('\n') }
  }

  private async grepSearch(call: ToolCall): Promise<ToolResult> {
    if (!call.pattern) return { success: false, output: '', error: 'grep_search requires pattern' }

    const files = await glob(call.scope ?? '**/*', {
      cwd: this.projectDir,
      ignore: ['node_modules/**', '.git/**', 'dist/**'],
      nodir: true
    })

    const regex = new RegExp(call.pattern, 'gi')
    const results: string[] = []

    for (const file of files) {
      try {
        const content = await readFile(path.join(this.projectDir, file), 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0
          if (regex.test(lines[i] ?? '')) {
            results.push(`${file}:${i + 1}: ${(lines[i] ?? '').trim()}`)
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return { success: true, output: results.join('\n') }
  }
}
