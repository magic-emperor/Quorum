import { writeFile } from 'fs/promises'
import path from 'path'
import type { ATLASRunOptions, VerifyResult, VerifyItem } from '../types.js'
import { TaskManager } from '../memory/task-manager.js'
import { PlanManager } from '../memory/plan-manager.js'

export async function runVerify(
  projectDir: string,
  options: ATLASRunOptions
): Promise<VerifyResult> {
  const { onProgress, onCheckpoint } = options

  onProgress?.('ATLAS Verification — User Acceptance Testing')
  onProgress?.('Walk through each deliverable and confirm it works.')
  onProgress?.('')

  const taskManager = new TaskManager(projectDir)
  const planManager = new PlanManager(projectDir)

  const [taskIndex, planIndex] = await Promise.all([
    taskManager.readIndex(),
    planManager.readIndex()
  ])

  const currentPhase = planIndex.phases.find(p => p.id === planIndex.current_phase)
  const completedTasks = taskIndex.tasks.filter(t =>
    t.status === 'COMPLETE' &&
    (!currentPhase || t.phase === planIndex.current_phase)
  )

  if (completedTasks.length === 0) {
    onProgress?.('No completed tasks found to verify.')
    onProgress?.('Complete some tasks first with atlas new or atlas fast.')
    return { deliverables: [], passed: 0, failed: 0, skipped: 0, ready_to_ship: false }
  }

  onProgress?.(`Found ${completedTasks.length} completed tasks to verify:`)
  onProgress?.('')

  const items: VerifyItem[] = completedTasks.map(t => ({
    id: t.id,
    description: t.title,
    status: 'pending' as const
  }))

  let passed = 0
  let failed = 0
  let skipped = 0

  for (const item of items) {
    if (options.auto) {
      item.status = 'pass'
      passed++
      onProgress?.(`  ✓ (auto) ${item.id}: ${item.description}`)
      continue
    }

    if (onCheckpoint) {
      onProgress?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
      onProgress?.(`${item.id}: ${item.description}`)
      onProgress?.('')

      const response = await onCheckpoint({
        type: 'BLOCKER',
        title: `Verify: ${item.description}`,
        completed: items.slice(0, items.indexOf(item)).filter(i => i.status === 'pass').map(i => i.description),
        question: `Does "${item.description}" work correctly?\n  Test it now, then answer.`,
        options: [
          { label: 'YES — works correctly', tradeoff: 'Mark as verified' },
          { label: 'NO — has issues', tradeoff: 'Record failure for fixing' },
          { label: 'SKIP — cannot test now', tradeoff: 'Mark as skipped' }
        ]
      })

      const r = response.toUpperCase()
      if (r === 'YES' || r === 'Y' || r === 'A' || r.includes('YES') || r.includes('WORKS')) {
        item.status = 'pass'
        passed++
        onProgress?.(`  ✓ PASS: ${item.description}`)
      } else if (r === 'SKIP' || r === 'C' || r.includes('SKIP')) {
        item.status = 'skip'
        skipped++
        onProgress?.(`  · SKIP: ${item.description}`)
      } else {
        item.status = 'fail'
        item.notes = response
        failed++
        onProgress?.(`  ✗ FAIL: ${item.description}`)
        if (response.length > 1) onProgress?.(`    Issue: ${response}`)
      }
    } else {
      item.status = 'skip'
      skipped++
    }
  }

  const readyToShip = failed === 0 && passed > 0

  const reportPath = path.join(projectDir, '.atlas', 'context', 'verify-report.md')
  const md = `# Verification Report
Date: ${new Date().toISOString()}
Phase: ${planIndex.current_phase}

## Summary
| Total | Passed | Failed | Skipped |
|-------|--------|--------|---------|
| ${items.length} | ${passed} | ${failed} | ${skipped} |

Ready to ship: ${readyToShip ? 'YES' : 'NO — fix failures first'}

## Results
${items.map(i => {
  const icon = i.status === 'pass' ? '✓' : i.status === 'fail' ? '✗' : '·'
  return `${icon} ${i.id}: ${i.description}${i.notes ? `\n  Issue: ${i.notes}` : ''}`
}).join('\n')}
`
  await writeFile(reportPath, md, 'utf-8')

  onProgress?.('')
  onProgress?.(`Verification complete: ${passed} passed, ${failed} failed, ${skipped} skipped`)

  if (readyToShip) {
    onProgress?.('Ready to ship. Run: atlas ship')
  } else if (failed > 0) {
    onProgress?.(`Fix ${failed} failing item(s), then run atlas verify again.`)
  }

  return { deliverables: items, passed, failed, skipped, ready_to_ship: readyToShip }
}
