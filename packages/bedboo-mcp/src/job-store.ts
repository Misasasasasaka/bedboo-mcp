import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BridgeError, type CommandReceipt, type Work } from './types.js'

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'interrupted' | 'cancelled'
type FinalState = Exclude<JobState, 'queued' | 'running'>
type StepState = 'pending' | 'sent' | CommandReceipt['state']
type JobRow = {
  id: string
  kind: Work['kind']
  state: JobState
  created_at: string
  started_at: string | null
  finished_at: string | null
  result: string | null
  error: string | null
}
type StepRow = {
  seq: number
  command: string
  at_ms: number | null
  state: StepState
  sent_at: string | null
  dispatched_at_ms: number | null
  receipt: string | null
}

function timestamp() { return new Date().toISOString() }

export class JobStore {
  private readonly lease: DatabaseSync
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.lease = new DatabaseSync(path + '.lock')
    try {
      // Releasing the process releases the SQLite lock even after an abrupt exit.
      this.lease.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      this.lease.close()
      throw new Error('Another bridge is using this Minecraft job database', { cause: error })
    }

    try {
      this.db = new DatabaseSync(path)
    } catch (error) {
      this.lease.close()
      throw error
    }
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, request_id TEXT UNIQUE, fingerprint TEXT NOT NULL,
          kind TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
          started_at TEXT, finished_at TEXT, result TEXT, error TEXT
        );
        CREATE TABLE IF NOT EXISTS steps (
          job_id TEXT NOT NULL REFERENCES jobs(id), seq INTEGER NOT NULL,
          command TEXT NOT NULL, at_ms INTEGER, state TEXT NOT NULL,
          sent_at TEXT, dispatched_at_ms REAL, receipt TEXT,
          PRIMARY KEY (job_id, seq)
        );
      `)
      this.transaction(() => {
        this.db.prepare("UPDATE steps SET state = 'unknown', receipt = ? WHERE state = 'sent'")
          .run(JSON.stringify({ state: 'unknown', error: 'Bridge stopped before receiving the response' }))
        this.db.prepare("UPDATE jobs SET state = 'interrupted', finished_at = ?, error = ? WHERE state IN ('queued', 'running')")
          .run(timestamp(), 'Bridge restarted before this job completed')
      })
    } catch (error) {
      this.db.close()
      this.lease.close()
      throw error
    }
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  create(work: Work, requestId?: string) {
    const fingerprint = createHash('sha256').update(JSON.stringify(work)).digest('hex')
    if (requestId !== undefined) {
      const previous = this.db.prepare('SELECT id, fingerprint FROM jobs WHERE request_id = ?').get(requestId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw new BridgeError('REQUEST_CONFLICT', 'This requestId belongs to a different operation')
        }
        return { id: String(previous.id), fresh: false }
      }
    }

    const id = randomUUID()
    this.transaction(() => {
      this.db.prepare("INSERT INTO jobs (id, request_id, fingerprint, kind, state, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
        .run(id, requestId ?? null, fingerprint, work.kind, timestamp())
      if (work.kind === 'move') return
      const insert = this.db.prepare("INSERT INTO steps (job_id, seq, command, at_ms, state) VALUES (?, ?, ?, ?, 'pending')")
      work.steps.forEach((step, index) => insert.run(id, index, step.command, step.atMs ?? null))
    })
    return { id, fresh: true }
  }

  markRunning(id: string) {
    this.db.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?").run(timestamp(), id)
  }

  finish(id: string, state: FinalState, result?: unknown, error?: string) {
    this.db.prepare('UPDATE jobs SET state = ?, finished_at = ?, result = ?, error = ? WHERE id = ?')
      .run(state, timestamp(), result === undefined ? null : JSON.stringify(result), error ?? null, id)
  }

  sent(id: string, index: number, dispatchedAtMs: number) {
    this.db.prepare("UPDATE steps SET state = 'sent', sent_at = ?, dispatched_at_ms = ? WHERE job_id = ? AND seq = ?")
      .run(timestamp(), dispatchedAtMs, id, index)
  }

  answer(id: string, index: number, receipt: CommandReceipt) {
    this.db.prepare('UPDATE steps SET state = ?, receipt = ? WHERE job_id = ? AND seq = ?')
      .run(receipt.state, JSON.stringify(receipt), id, index)
  }

  activeJob() {
    const row = this.db.prepare("SELECT id FROM jobs WHERE state = 'running' LIMIT 1").get()
    return row ? String(row.id) : null
  }

  progress(id: string) {
    const progress: Record<StepState, number> = { pending: 0, sent: 0, succeeded: 0, failed: 0, unknown: 0 }
    const rows = this.db.prepare('SELECT state, COUNT(*) AS count FROM steps WHERE job_id = ? GROUP BY state')
      .all(id) as { state: StepState; count: number }[]
    for (const row of rows) progress[row.state] = row.count
    return progress
  }

  get(id: string, cursor = 0, limit = 50) {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    if (!job) throw new BridgeError('JOB_NOT_FOUND', 'No job exists with this ID')

    const rows = this.db.prepare('SELECT * FROM steps WHERE job_id = ? AND seq >= ? ORDER BY seq LIMIT ?')
      .all(id, cursor, limit + 1) as StepRow[]
    const steps = rows.slice(0, limit).map(row => ({
      index: row.seq,
      command: row.command,
      atMs: row.at_ms,
      state: row.state,
      sentAt: row.sent_at,
      dispatchedAtMs: row.dispatched_at_ms,
      receipt: row.receipt === null ? null : JSON.parse(row.receipt) as CommandReceipt,
    }))
    return {
      jobId: job.id,
      kind: job.kind,
      state: job.state,
      createdAt: job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      result: job.result === null ? null : JSON.parse(job.result) as unknown,
      error: job.error,
      progress: this.progress(id),
      steps,
      nextCursor: rows[limit]?.seq ?? null,
    }
  }

  close() {
    this.db.close()
    this.lease.close()
  }
}
