/**
 * 生络 — 产品层自己的持久化。
 *
 * 只存「生络产品层」的数据：节点策展、界面偏好、本次正在推进的事、授权元信息。
 * 权威数据不在这里：个人现实在 Family Space，执行过程在 DSH 原生 Session，
 * 成果在工作区文件。所以这份状态永远可以重建，删了也不丢事实。
 *
 * 不把 Family Space 返回的正文写进来（验收 14）：reality 段只有授权状态与元信息。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { nowIso, writeJsonAtomic } from './util.mjs'

const STATE_VERSION = 1

function emptyState() {
  return {
    version: STATE_VERSION,
    installationId: null,
    prefs: { panel: 'today', reducedMotion: false },
    reality: {
      state: 'unauthorized',
      subject: null,
      scopes: [],
      authorizedAt: null,
      expiresAt: null,
      lastQueriedAt: null,
      lastError: null,
    },
    relations: [],
    nodeMarks: {},
    runs: {},
    understandings: [],
    corrections: [],
    activeRunId: null,
    updatedAt: nowIso(),
  }
}

function migrate(raw) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  const merged = { ...base, ...raw }
  merged.version = STATE_VERSION
  merged.prefs = { ...base.prefs, ...(raw.prefs && typeof raw.prefs === 'object' ? raw.prefs : {}) }
  merged.reality = { ...base.reality, ...(raw.reality && typeof raw.reality === 'object' ? raw.reality : {}) }
  merged.relations = Array.isArray(raw.relations) ? raw.relations.filter((r) => r && r.from && r.to) : []
  merged.nodeMarks = raw.nodeMarks && typeof raw.nodeMarks === 'object' ? raw.nodeMarks : {}
  merged.runs = raw.runs && typeof raw.runs === 'object' ? raw.runs : {}
  merged.understandings = Array.isArray(raw.understandings) ? raw.understandings : []
  merged.corrections = Array.isArray(raw.corrections) ? raw.corrections.filter((item) => item && typeof item.text === 'string') : []
  merged.activeRunId = typeof raw.activeRunId === 'string' ? raw.activeRunId : null
  return merged
}

export class Store {
  constructor(dataDir) {
    this.dir = dataDir
    this.file = join(dataDir, 'product-state.json')
    mkdirSync(dataDir, { recursive: true })
    this.state = this.#load()
    this.queue = Promise.resolve()
    if (this.#sanitize()) this.#persist()
    if (!this.state.installationId) {
      this.state.installationId = (globalThis.crypto?.randomUUID?.() ?? String(Date.now()))
      this.#persist()
    }
  }

  #load() {
    if (!existsSync(this.file)) return emptyState()
    try {
      return migrate(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      // 坏了就当空状态重建：这里没有权威数据，重建不丢事实。
      try { writeJsonAtomic(this.file + '.corrupt-' + Date.now(), { note: 'unreadable product state, rebuilt' }) } catch {}
      return emptyState()
    }
  }

  /** 旧状态里可能留下理解/候选正文：启动时清掉，只留指针与元数据。 */
  #sanitize() {
    let changed = false
    for (const run of Object.values(this.state.runs ?? {})) {
      if (run.understanding !== undefined) { delete run.understanding; changed = true }
      if (Array.isArray(run.candidates)) {
        for (const candidate of run.candidates) {
          if (candidate.content !== undefined) { delete candidate.content; changed = true }
          if (candidate.detail !== undefined) { delete candidate.detail; changed = true }
        }
      }
      if (run.report && run.report.understanding !== undefined) { delete run.report.understanding; changed = true }
      if (run.report && run.report.next !== undefined) { delete run.report.next; changed = true }
    }
    return changed
  }

  #persist() {
    this.state.updatedAt = nowIso()
    writeJsonAtomic(this.file, this.state)
  }

  get() {
    return this.state
  }

  /** 串行写：并发调用按调用顺序落盘，最后的状态可预测。 */
  update(mutator) {
    const run = async () => {
      const result = mutator(this.state)
      this.#persist()
      return result
    }
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  // —— 授权元信息（没有正文） ——

  realityMeta() {
    return { ...this.state.reality }
  }

  markAuthorized({ subject, scopes, authorizedAt, expiresAt }) {
    return this.update((state) => {
      state.reality = {
        state: 'authorized',
        subject: subject ?? null,
        scopes: Array.isArray(scopes) ? scopes : [],
        authorizedAt: authorizedAt ?? nowIso(),
        expiresAt: expiresAt ?? null,
        lastQueriedAt: state.reality.lastQueriedAt,
        lastError: null,
      }
    })
  }

  markRealityState(nextState, lastError = null) {
    return this.update((state) => {
      state.reality.state = nextState
      state.reality.lastError = lastError
      if (nextState !== 'authorized') {
        state.reality.subject = null
        state.reality.scopes = []
        state.reality.expiresAt = null
      }
    })
  }

  markQueried() {
    return this.update((state) => { state.reality.lastQueriedAt = nowIso() })
  }

  // —— 策展 ——

  addRelation({ from, to, relation, note }) {
    return this.update((state) => {
      const exists = state.relations.some((r) => r.from === from && r.to === to && r.relation === relation)
      if (!exists) {
        state.relations.push({ from, to, relation, note: note ?? '', at: nowIso(), by: 'owner' })
        // 只留最近的 200 条人工关系，够用且不会把文件撑大。
        if (state.relations.length > 200) state.relations = state.relations.slice(-200)
      }
      return { ok: true, count: state.relations.length }
    })
  }

  removeRelation({ from, to, relation }) {
    return this.update((state) => {
      state.relations = state.relations.filter((r) => !(r.from === from && r.to === to && r.relation === relation))
    })
  }

  setPrefs(patch) {
    return this.update((state) => { state.prefs = { ...state.prefs, ...(patch ?? {}) } })
  }

  markNode(id, patch) {
    return this.update((state) => {
      state.nodeMarks[id] = { ...(state.nodeMarks[id] ?? {}), ...(patch ?? {}) }
    })
  }

  // —— 正在推进的事（只是索引；执行过程在原生 Session） ——

  startRun({ sessionId, goal, cwd, workspaceBaseline = null }) {
    return this.update((state) => {
      const runId = 'run-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7)
      state.runs[runId] = {
        runId, sessionId, goal, cwd: cwd ?? null, workspaceBaseline: workspaceBaseline ?? null,
        startedAt: nowIso(), updatedAt: nowIso(),
        status: 'running', phase: 'understanding',
        steps: [], understanding: null, understandingSource: null, understandingCaptured: false,
        verifications: [], candidates: [], artifacts: [],
        artifactPaths: [], decisions: [],
      }
      state.activeRunId = runId
      return runId
    })
  }

  patchRun(runId, patch) {
    return this.update((state) => {
      const run = state.runs[runId]
      if (!run) return null
      Object.assign(run, patch, { updatedAt: nowIso() })
      return run
    })
  }

  addArtifact(runId, artifact) {
    return this.update((state) => {
      const run = state.runs[runId]
      if (!run) return null
      const key = artifact.path
      if (!run.artifactPaths.some((a) => a.path === key)) run.artifactPaths.push(artifact)
      return run
    })
  }

  addDecision(runId, decision) {
    return this.update((state) => {
      const run = state.runs[runId]
      if (!run) return null
      if (!run.decisions.some((d) => d.id === decision.id)) run.decisions.push(decision)
      return run
    })
  }

  activeRun() {
    const id = this.state.activeRunId
    return id ? this.state.runs[id] ?? null : null
  }

  recentUnderstandings(limit = 5) {
    return (this.state.understandings ?? []).slice(-Math.max(1, limit)).reverse()
  }

  upsertUnderstanding(entry) {
    if (!entry || !entry.runId) return null
    return this.update((state) => {
      const list = Array.isArray(state.understandings) ? state.understandings : []
      const next = list.filter((item) => item.runId !== entry.runId)
      next.push(entry)
      state.understandings = next.slice(-50)
      return entry
    })
  }

  corrections(limit = 20) {
    return (this.state.corrections ?? []).slice(-Math.max(1, limit))
  }

  addCorrection({ text, runId = null, sourceRefs = [] }) {
    const value = String(text ?? '').trim().slice(0, 500)
    if (!value) return null
    return this.update((state) => {
      const correction = {
        id: 'corr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        text: value,
        runId,
        sourceRefs: Array.isArray(sourceRefs) ? sourceRefs.slice(0, 10) : [],
        at: nowIso(),
        status: 'confirmed',
      }
      state.corrections = [...(state.corrections ?? []), correction].slice(-100)
      return correction
    })
  }

  recentRuns(limit = 10) {
    return Object.values(this.state.runs)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, limit)
  }
}
