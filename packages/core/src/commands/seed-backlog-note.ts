import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { QUORUMRunOptions, Seed, BacklogItem } from '../types.js'

export async function runSeed(
  idea: string,
  projectDir: string,
  options: QUORUMRunOptions
): Promise<void> {
  const { onProgress } = options
  const seedsPath = path.join(projectDir, '.quorum', 'SEEDS.md')
  const seedsJsonPath = path.join(projectDir, '.quorum', 'nervous-system', 'seeds.json')

  const seed: Seed = {
    id: `seed_${Date.now()}`,
    idea,
    trigger: options.extra?.trigger ?? 'next milestone',
    created_date: new Date().toISOString().split('T')[0]!,
    created_session: `session_${Date.now()}`,
    status: 'pending'
  }

  const existing = existsSync(seedsPath)
    ? await readFile(seedsPath, 'utf-8')
    : '# Seeds — Future Ideas\n<!-- Ideas to surface at the right time. Never acted on immediately. -->\n\n'

  await writeFile(
    seedsPath,
    existing + `\n## ${seed.id}\n**Idea:** ${idea}\n**Surface at:** ${seed.trigger}\n**Added:** ${seed.created_date}\n**Status:** ${seed.status}\n\n---\n`,
    'utf-8'
  )

  const seeds: Seed[] = existsSync(seedsJsonPath)
    ? JSON.parse(await readFile(seedsJsonPath, 'utf-8'))
    : []
  seeds.push(seed)
  await writeFile(seedsJsonPath, JSON.stringify(seeds, null, 2), 'utf-8')

  onProgress?.(`Seed captured: "${idea}"`)
  onProgress?.(`Will surface at: ${seed.trigger}`)
  onProgress?.('Not acted on now — you can focus on current work.')
}

export async function runBacklog(
  subcommand: string,
  description: string,
  projectDir: string,
  options: QUORUMRunOptions
): Promise<void> {
  const { onProgress } = options
  const backlogPath = path.join(projectDir, '.quorum', 'BACKLOG.md')
  const backlogJsonPath = path.join(projectDir, '.quorum', 'nervous-system', 'backlog.json')

  const loadBacklog = async (): Promise<BacklogItem[]> => {
    if (!existsSync(backlogJsonPath)) return []
    return JSON.parse(await readFile(backlogJsonPath, 'utf-8'))
  }

  const saveBacklog = async (items: BacklogItem[]): Promise<void> => {
    await writeFile(backlogJsonPath, JSON.stringify(items, null, 2), 'utf-8')

    const md = `# Backlog
<!-- Items parked outside the active roadmap. Promote to tasks when ready. -->

${items.filter(i => i.status === 'backlog').map((item, i) => `## ${i + 1}. ${item.id}
**Description:** ${item.description}
**Added:** ${item.added_date}
**Priority:** ${item.priority ?? 'medium'}
**Status:** ${item.status}

---`).join('\n\n')}

## Promoted
${items.filter(i => i.status === 'promoted').map(i => `- ${i.description} → ${i.promoted_to}`).join('\n') || '(none)'}

## Dismissed
${items.filter(i => i.status === 'dismissed').map(i => `- ${i.description}`).join('\n') || '(none)'}
`
    await writeFile(backlogPath, md, 'utf-8')
  }

  switch (subcommand) {
    case 'add': {
      const items = await loadBacklog()
      const item: BacklogItem = {
        id: `backlog_${Date.now()}`,
        description,
        added_date: new Date().toISOString().split('T')[0]!,
        added_session: `session_${Date.now()}`,
        priority: (options.extra?.priority as BacklogItem['priority']) ?? 'medium',
        status: 'backlog'
      }
      items.push(item)
      await saveBacklog(items)
      onProgress?.(`Added to backlog: "${description}"`)
      onProgress?.(`Use quorum backlog list to see all backlog items.`)
      break
    }

    case 'list': {
      const items = await loadBacklog()
      const active = items.filter(i => i.status === 'backlog')
      if (active.length === 0) {
        onProgress?.('Backlog is empty.')
        return
      }
      onProgress?.(`BACKLOG (${active.length} items):`)
      onProgress?.('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      active.forEach((item, i) => {
        onProgress?.(`  ${i + 1}. [${item.priority}] ${item.description}`)
      })
      onProgress?.('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      onProgress?.('Use quorum backlog promote <number> to move to active tasks.')
      break
    }

    case 'promote': {
      const items = await loadBacklog()
      const idx = parseInt(description, 10) - 1
      const item = items.filter(i => i.status === 'backlog')[idx]
      if (!item) {
        onProgress?.(`No backlog item #${idx + 1}`)
        return
      }
      item.status = 'promoted'
      item.promoted_to = 'pending task creation'
      await saveBacklog(items)
      onProgress?.(`Promoted: "${item.description}"`)
      onProgress?.(`Now run: quorum new "${item.description}"`)
      break
    }

    default:
      onProgress?.('Usage: quorum backlog [add|list|promote] [description/number]')
  }
}

export async function runNote(
  text: string,
  projectDir: string,
  options: QUORUMRunOptions
): Promise<void> {
  const { onProgress } = options
  const notesPath = path.join(projectDir, '.quorum', 'NOTES.md')

  const existing = existsSync(notesPath)
    ? await readFile(notesPath, 'utf-8')
    : '# Notes\n\n'

  const entry = `## ${new Date().toISOString().split('T')[0]!} — ${new Date().toLocaleTimeString()}\n${text}\n\n---\n`
  await writeFile(notesPath, existing + entry, 'utf-8')

  onProgress?.(`Note saved to .quorum/NOTES.md`)
}
