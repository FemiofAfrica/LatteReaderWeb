// Real-browser verification of the truthful transport strip against the live private preview.
// Scenario A: a few transient POST failures must read as degraded ("live retrying"), must NOT
//   lose the batch (bounded retry), and must return to "private live" after a success.
// Scenario B: an endpoint that never accepts must read as genuinely not connected
//   ("live unavailable"), never a permanent "live connecting".
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const base = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4176/'
const log = resolve('.runtime/diagnostics/events.jsonl')
const fixture = resolve('tests/fixtures/latte-reader-text-fixture.pdf')
const browser = await chromium.launch({ headless: true })

async function session({ abortAttempts }) {
  const page = await browser.newPage()
  let count = 0
  await page.route('**/__latte_diagnostics/events', async (route) => {
    count++
    if (abortAttempts(count)) return route.abort('failed')
    return route.continue()
  })
  const timeline = []
  let last = ''
  const sample = async () => { const t = await page.locator('.diagnostics-panel summary').innerText().catch(() => ''); if (t && t !== last) { timeline.push(t); last = t } }
  await page.goto(base)
  await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor({ timeout: 15000 })
  await page.locator('input[type=file]').setInputFiles(fixture)
  await page.getByText('Extraction complete', { exact: true }).waitFor({ timeout: 30000 })
  const end = Date.now() + 6000
  while (Date.now() < end) { await sample(); await page.waitForTimeout(60) }
  await sample()
  await page.close()
  return { timeline, posts: count }
}

try {
  // Scenario A: abort only the 2nd and 3rd attempts -> degraded, then recovered, batch retained.
  const a = await session({ abortAttempts: n => n === 2 || n === 3 })
  const degradedSeen = a.timeline.some(t => t.includes('live retrying'))
  const liveSeen = a.timeline.some(t => t.includes('private live'))
  assert(degradedSeen, `Expected a degraded reading, saw: ${JSON.stringify(a.timeline)}`)
  assert(liveSeen && a.timeline.at(-1).includes('private live'), `Not recovered to live, saw: ${JSON.stringify(a.timeline)}`)
  const rows = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const recentSessions = new Set(rows.slice(-80).map(r => r.sessionId))
  // The retried batch's lifecycle events must still have landed after the transient failures.
  const landed = rows.filter(r => recentSessions.has(r.sessionId)).map(r => r.event)
  assert(landed.includes('extraction.complete'), 'retried batch never landed; events were lost')

  // Scenario B: every send fails -> genuinely not connected, and never a permanent "connecting".
  const b = await session({ abortAttempts: () => true })
  assert(b.timeline.some(t => t.includes('live unavailable')), `Expected "live unavailable", saw: ${JSON.stringify(b.timeline)}`)
  assert(!b.timeline.at(-1).includes('live connecting'), 'Strip stuck on a permanent "live connecting"')

  console.log(JSON.stringify({
    status: 'passed',
    scenarioA: { timeline: a.timeline, posts: a.posts, degradedSeen, recovered: a.timeline.at(-1) },
    scenarioB: { timeline: b.timeline, posts: b.posts },
    verified: ['degraded state shown on transient failure', 'recovered to live after success', 'retried batch reached the log', 'genuinely-not-connected state shown', 'no permanent connecting state'],
  }, null, 2))
} finally {
  await browser.close()
}
