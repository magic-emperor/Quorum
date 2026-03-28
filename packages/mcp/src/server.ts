#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from '@modelcontextprotocol/sdk/types.js'
import { QUORUMEngine, FunctionRegistry } from '@quorum/core'
import path from 'path'

const server = new Server(
  { name: 'quorum', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// ─── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'quorum_new',
      description: 'Build a new feature or application from scratch. Runs the full QUORUM pipeline: scope check → plan → architecture → design → build → integrate → test.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What to build' },
          project_dir: { type: 'string', description: 'Project directory path' },
          auto: { type: 'boolean', description: 'Skip all human checkpoints', default: false }
        },
        required: ['description']
      }
    },
    {
      name: 'quorum_enhance',
      description: 'Modify or extend an existing feature. Loads full project context, runs scope guard, uses function registry for cheap navigation, makes targeted changes.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What to change or add' },
          project_dir: { type: 'string' }
        },
        required: ['description']
      }
    },
    {
      name: 'quorum_fast',
      description: 'Execute a small task directly without the full pipeline. Best for < 5 file changes.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'The small task to execute' },
          project_dir: { type: 'string' }
        },
        required: ['description']
      }
    },
    {
      name: 'quorum_next',
      description: 'Auto-detect what to do next based on current project state.',
      inputSchema: {
        type: 'object',
        properties: { project_dir: { type: 'string' } }
      }
    },
    {
      name: 'quorum_status',
      description: 'Show current QUORUM state — tasks, plan progress, model routing.',
      inputSchema: {
        type: 'object',
        properties: {
          project_dir: { type: 'string' },
          include_routing: { type: 'boolean', default: false },
          include_decisions: { type: 'boolean', default: false },
          include_progress: { type: 'boolean', default: false }
        }
      }
    },
    {
      name: 'quorum_task_list',
      description: 'List all project tasks with their status.',
      inputSchema: {
        type: 'object',
        properties: {
          project_dir: { type: 'string' },
          status: {
            type: 'string',
            enum: ['all', 'todo', 'in_progress', 'complete', 'blocked'],
            default: 'all'
          }
        }
      }
    },
    {
      name: 'quorum_goal',
      description: 'Read the project goal definition — what is in scope and what is not.',
      inputSchema: {
        type: 'object',
        properties: { project_dir: { type: 'string' } }
      }
    },
    {
      name: 'quorum_discuss',
      description: 'Gather context and surface important questions BEFORE planning starts. Prevents wrong assumptions.',
      inputSchema: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Feature to discuss' },
          project_dir: { type: 'string' }
        },
        required: ['feature']
      }
    },
    {
      name: 'quorum_debug',
      description: 'Systematic debugging — traces root cause and proposes targeted fix.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Error message or problem description' },
          project_dir: { type: 'string' },
          auto_apply: { type: 'boolean', description: 'Auto-apply the proposed fix', default: false }
        },
        required: ['description']
      }
    },
    {
      name: 'quorum_review',
      description: 'Code + security review of uncommitted changes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Specific path to review (optional)' },
          project_dir: { type: 'string' }
        }
      }
    },
    {
      name: 'quorum_functions',
      description: 'Query the function registry — find any function by name, file, or purpose. 98.8% cheaper than reading source files directly.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Function name, file path, or keyword' },
          project_dir: { type: 'string' }
        },
        required: ['query']
      }
    },
    {
      name: 'quorum_rollback',
      description: 'Return project to a previous rollback point. Lists points if no ID given.',
      inputSchema: {
        type: 'object',
        properties: {
          rollback_point: { type: 'string', description: 'Rollback point ID' },
          project_dir: { type: 'string' },
          list: { type: 'boolean', description: 'List available points', default: false }
        }
      }
    },
    {
      name: 'quorum_session_report',
      description: 'Generate summary of what was done this session.',
      inputSchema: {
        type: 'object',
        properties: { project_dir: { type: 'string' } }
      }
    },
    {
      name: 'quorum_doctor',
      description: 'Check QUORUM health — API keys, Playwright, .quorum/ integrity.',
      inputSchema: {
        type: 'object',
        properties: {
          project_dir: { type: 'string' },
          repair: { type: 'boolean', description: 'Auto-fix repairable issues', default: false }
        }
      }
    }
  ]
}))

// ─── Tool execution ───────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params
  const a = (args ?? {}) as Record<string, unknown>

  const projectDir = typeof a['project_dir'] === 'string'
    ? path.resolve(a['project_dir'])
    : process.cwd()

  const outputLines: string[] = []
  const collect = (msg: string) => outputLines.push(msg)

  const engine = new QUORUMEngine({ projectDir })
  const autoCheckpoint = async () => 'APPROVE'

  try {
    switch (name) {
      case 'quorum_new':
        await engine.run({
          command: 'new',
          description: String(a['description'] ?? ''),
          projectDir,
          onProgress: collect,
          onCheckpoint: autoCheckpoint,
          auto: Boolean(a['auto'])
        })
        break

      case 'quorum_enhance':
        await engine.run({
          command: 'enhance',
          description: String(a['description'] ?? ''),
          projectDir,
          onProgress: collect,
          onCheckpoint: autoCheckpoint
        })
        break

      case 'quorum_fast':
        await engine.run({
          command: 'fast',
          description: String(a['description'] ?? ''),
          projectDir,
          onProgress: collect
        })
        break

      case 'quorum_next':
        await engine.run({ command: 'next', projectDir, onProgress: collect })
        break

      case 'quorum_status':
        await engine.run({
          command: 'status',
          projectDir,
          onProgress: collect,
          extra: {
            routing: String(a['include_routing'] ?? false),
            decisions: String(a['include_decisions'] ?? false),
            progress: String(a['include_progress'] ?? false)
          }
        })
        break

      case 'quorum_task_list': {
        await engine.initialize()
        const tm = (engine as unknown as { taskManager: { readIndex: () => Promise<{ tasks: Array<{ id: string; title: string; status: string }> }> } }).taskManager
        if (tm) {
          const idx = await tm.readIndex()
          const statusFilter = String(a['status'] ?? 'all').toUpperCase()
          const tasks = statusFilter === 'ALL' ? idx.tasks
            : idx.tasks.filter(t => t.status === statusFilter)
          outputLines.push(`Tasks: ${tasks.length} (${statusFilter})`)
          tasks.forEach(t => {
            const icon = t.status === 'COMPLETE' ? '✓'
              : t.status === 'IN_PROGRESS' ? '→'
              : t.status === 'BLOCKED' ? '✗' : '○'
            outputLines.push(`${icon} ${t.id}: ${t.title}`)
          })
        }
        break
      }

      case 'quorum_goal': {
        await engine.initialize()
        const gg = (engine as unknown as { goalGuardian: { readRaw?: () => Promise<string> } }).goalGuardian
        if (gg?.readRaw) {
          const raw = await gg.readRaw()
          outputLines.push(raw || 'No goal.md found. Run: quorum init')
        } else {
          outputLines.push('No goal guardian available. Run: quorum init')
        }
        break
      }

      case 'quorum_discuss':
        await engine.run({
          command: 'discuss',
          description: String(a['feature'] ?? ''),
          projectDir,
          onProgress: collect
        })
        break

      case 'quorum_debug':
        await engine.run({
          command: 'debug',
          description: String(a['description'] ?? ''),
          projectDir,
          onProgress: collect,
          onCheckpoint: autoCheckpoint,
          auto: Boolean(a['auto_apply'])
        })
        break

      case 'quorum_review':
        await engine.run({
          command: 'review',
          description: typeof a['path'] === 'string' ? a['path'] : undefined,
          projectDir,
          onProgress: collect
        })
        break

      case 'quorum_functions': {
        const fr = new FunctionRegistry(projectDir)
        const query = String(a['query'] ?? '')
        const byName = await fr.findByName(query)
        const byFile = await fr.findByFile(query)
        const results = [...byName, ...byFile].slice(0, 10)

        if (results.length === 0) {
          outputLines.push(`No functions found matching: ${query}`)
          outputLines.push('Tip: run quorum sync to build the function registry first.')
        } else {
          outputLines.push(`Found ${results.length} function(s):`)
          results.forEach(f => {
            outputLines.push(`${f.id}: ${f.name}()`)
            outputLines.push(`  File: ${f.file}:${f.line_start}-${f.line_end}`)
            outputLines.push(`  Purpose: ${f.purpose}`)
            outputLines.push(`  Tags: ${f.tags.join(', ')}`)
            if (f.called_from.length > 0) {
              outputLines.push(`  Called from: ${f.called_from.map((c: { file: string; line: number }) => `${c.file}:${c.line}`).join(', ')}`)
            }
            outputLines.push('')
          })
        }
        break
      }

      case 'quorum_rollback':
        await engine.run({
          command: 'rollback',
          description: typeof a['rollback_point'] === 'string' ? a['rollback_point'] : undefined,
          projectDir,
          onProgress: collect,
          onCheckpoint: autoCheckpoint,
          extra: { list: String(a['list'] ?? false) }
        })
        break

      case 'quorum_session_report':
        await engine.run({ command: 'session-report', projectDir, onProgress: collect })
        break

      case 'quorum_doctor':
        await engine.run({
          command: 'doctor',
          projectDir,
          onProgress: collect,
          extra: { repair: String(a['repair'] ?? false) }
        })
        break

      default:
        outputLines.push(`Unknown tool: ${name}`)
    }
  } catch (err) {
    outputLines.push(`Error: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    content: [{ type: 'text', text: outputLines.join('\n') }]
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('QUORUM MCP server running on stdio\n')
}

main().catch(err => {
  process.stderr.write(`QUORUM MCP error: ${err}\n`)
  process.exit(1)
})
