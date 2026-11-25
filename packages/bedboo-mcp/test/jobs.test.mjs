import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { test } from 'node:test'
import { JobStore } from '../dist/job-store.js'
import { GameJobs } from '../dist/jobs.js'

async function databasePath(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bedboo-mcp-job-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  return join(directory, 'queue.sqlite')
}

const successfulReply = {
  output_type: 'all',
  success_count: 1,
  output: [{ message_id: 'commands.test.success', parameters: ['value'], success: true }],
}

function fakeSession(request) {
  const bot = { _bedrock: { commands: { request } } }
  const signal = new AbortController().signal
  return {
    requireConnection: () => ({ bot, signal }),
    move: async () => ({ dimension: 'overworld', position: { x: 12, y: 65, z: 0 } }),
  }
}

test('a repeated request ID returns the persisted result without resending', async t => {
  const path = await databasePath(t)
  let calls = 0
  const session = fakeSession(async () => { calls++; return successfulReply })
  const work = { kind: 'command', steps: [{ command: '/help' }] }

  const jobs = new GameJobs(session, new JobStore(path), 200)
  const id = jobs.submit(work, 'repeat')
  assert.equal(jobs.submit(work, 'repeat'), id)
  try {
    const first = await jobs.waitForCommand(id)
    assert.equal(first.state, 'succeeded')
    assert.equal(first.steps[0].receipt.messages[0].parameters[0], 'value')
    assert.throws(() => jobs.submit({ kind: 'command', steps: [{ command: '/time query daytime' }] }, 'repeat'),
      { code: 'REQUEST_CONFLICT' })
  } finally { await jobs.close() }

  const restarted = new GameJobs(session, new JobStore(path), 200)
  try {
    assert.equal(restarted.submit(work, 'repeat'), id)
    assert.equal((await restarted.waitForCommand(id)).state, 'succeeded')
    assert.equal(calls, 1)
  } finally { await restarted.close() }
})

test('dispatches equal offsets in order without waiting for earlier timed receipts', async t => {
  const path = await databasePath(t)
  const dispatches = []
  const resolves = []
  let now = 0
  const session = fakeSession(command => {
    dispatches.push([command, now])
    return new Promise(resolve => resolves.push(resolve))
  })
  const clock = { now: () => now, wait: async ms => { now += ms } }
  const jobs = new GameJobs(session, new JobStore(path), 200, clock)
  try {
    const id = jobs.submit({ kind: 'commands', steps: [
      { command: '/say first', atMs: 0 },
      { command: '/say second', atMs: 0 },
      { command: '/say third', atMs: 125 },
    ] })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(dispatches, [['/say first', 0], ['/say second', 0], ['/say third', 125]])
    resolves.forEach(resolve => resolve(successfulReply))
    const after = await jobs.waitForCommand(id)
    assert.equal(after.state, 'succeeded')
    assert.equal(after.progress.succeeded, 3)
    assert.deepEqual(after.steps.map(step => step.dispatchedAtMs), [0, 0, 125])
  } finally {
    resolves.forEach(resolve => resolve(successfulReply))
    await jobs.close()
  }
})

test('cancel stops later commands and preserves the first receipt', async t => {
  const path = await databasePath(t)
  const dispatches = []
  const jobs = new GameJobs(fakeSession(async command => {
    dispatches.push(command)
    return successfulReply
  }), new JobStore(path), 200)
  try {
    const id = jobs.submit({ kind: 'commands', steps: [
      { command: '/say first', atMs: 0 },
      { command: '/say later', atMs: 30000 },
    ] })
    await wait(10)
    jobs.cancel(id)
    const result = await jobs.waitForCommand(id)
    assert.equal(result.state, 'cancelled')
    assert.deepEqual(dispatches, ['/say first'])
    assert.deepEqual(result.steps.map(step => step.state), ['succeeded', 'pending'])
  } finally { await jobs.close() }
})

test('reads uncertain steps after restart and leaves unsent commands pending', async t => {
  const path = await databasePath(t)
  const store = new JobStore(path)
  assert.throws(() => new JobStore(path), /Another bridge/)
  const { id } = store.create({ kind: 'commands', steps: [
    { command: '/say first' }, { command: '/say never dispatched' },
  ] }, 'before-crash')
  store.markRunning(id)
  store.sent(id, 0, 0)
  store.close()

  const restarted = new JobStore(path)
  try {
    const result = restarted.get(id)
    assert.equal(result.state, 'interrupted')
    assert.deepEqual(result.steps.map(step => step.state), ['unknown', 'pending'])
    assert.equal(restarted.get(id, 0, 1).nextCursor, 1)
  } finally { restarted.close() }
})
