/**
 * 生络 — 工作环路：终态判定、验收规则、回流候选。
 *
 * 硬规则（与 V2_智能工作闭环设计.md 一致）：
 * - 调用工具 ≠ 成功（由 events.mjs 配对）；
 * - 一轮会话结束 ≠ 验收通过（本文件才给终态）；
 * - 没有交付物的执行任务不能算「已完成」；
 * - 答复型任务可以没有文件，但必须留下真实理解（缺了就如实说明）。
 *
 * 纯函数：不碰 fs、不碰 DSH，输入全是已扫描好的事实。
 */

import { gitChanged } from './gitstate.mjs'

const WRITE_TOOLS = new Set(['write', 'edit', 'bash', 'pwsh'])

export const FINAL_STATUS = {
  COMPLETED: 'completed',
  ANSWERED: 'answered',
  FAILED: 'failed',
  STOPPED: 'stopped-by-owner',
}

/** 这次 run 有没有「会改变世界的」工具调用（写类）。 */
export function hasWriteSteps(run) {
  const steps = Array.isArray(run?.steps) ? run.steps : []
  return steps.some((step) => step && WRITE_TOOLS.has(step.name))
}

/**
 * 验收一组成果文件。artifact 形状（由 index.js 扫描）：
 * { path, exists, size, sha256, modifiedAt, duringRun }
 */
export function verifyArtifacts(artifacts = []) {
  return artifacts.map((artifact) => {
    const checks = {
      exists: artifact?.exists === true,
      nonEmpty: Number(artifact?.size ?? 0) > 0,
      duringRun: artifact?.duringRun !== false,
    }
    const ok = checks.exists && checks.nonEmpty && checks.duringRun
    const reason = !checks.exists
      ? '文件不存在'
      : !checks.nonEmpty
        ? '文件是空的'
        : !checks.duringRun
          ? '文件不是这次做出来的（时间对不上）'
          : ''
    return {
      path: artifact?.path ?? '',
      ok,
      reason,
      checks,
      size: Number(artifact?.size ?? 0),
      sha256: artifact?.sha256 ?? null,
      modifiedAt: artifact?.modifiedAt ?? null,
    }
  })
}

function verifyChanges(changes = {}) {
  const before = changes?.git?.before ?? null
  const after = changes?.git?.after ?? null
  const anyChange = gitChanged(before, after) || changes?.git?.changed === true
  const tests = Array.isArray(changes?.tests)
    ? changes.tests.map((test) => ({
        command: String(test?.command ?? ''),
        name: test?.name ?? null,
        ok: test?.ok !== false,
        at: test?.at ?? null,
      }))
    : []
  const testFailures = tests.filter((test) => !test.ok).length
  return {
    git: {
      anyChange,
      beforeHead: before?.head ?? null,
      afterHead: after?.head ?? null,
      changedFiles: Array.isArray(after?.changed) ? after.changed.slice(0, 12) : [],
    },
    tests,
    anyChange,
    testFailures,
    ok: anyChange && testFailures === 0,
  }
}

function actionOf(run) {
  const declared = run?.understanding?.action
  if (declared) return declared
  if (hasWriteSteps(run)) return 'execute'
  return 'answer'
}

/**
 * 决定这次 run 的终态。
 * @returns {{ status, phase, endReason, endNote, action, verifications, report }}
 */
export function decideOutcome({ run, turnReason, artifacts = [], changes = {} } = {}) {
  const action = actionOf(run)
  const reasonKind = String(turnReason?.kind ?? 'completed')

  if (run?.approvalRejected) {
    return {
      status: FINAL_STATUS.STOPPED,
      phase: 'stopped-by-owner',
      endReason: 'approval-rejected',
      endNote: '你拒绝了这一步，所以这件事没有做成——这是你的决定，我按它停下了。',
      action,
      verifications: [],
      report: null,
    }
  }

  if (reasonKind !== 'completed') {
    return {
      status: FINAL_STATUS.FAILED,
      phase: 'failed',
      endReason: reasonKind,
      endNote: reasonKind === 'error'
        ? (turnReason?.error?.message ?? '模型请求失败')
        : '这次没有正常做完（' + reasonKind + '）。',
      action,
      verifications: [],
      report: null,
    }
  }

  const verifications = verifyArtifacts(artifacts)
  const anyArtifact = verifications.length > 0
  const allOk = anyArtifact && verifications.every((item) => item.ok)
  const changeCheck = verifyChanges(changes)

  if (action === 'execute') {
    if (allOk) {
      return {
        status: FINAL_STATUS.COMPLETED,
        phase: 'completed',
        endReason: 'verified',
        endNote: changeCheck.anyChange ? '成果文件和项目改动都核对过了。' : '',
        action,
        verifications,
        changeVerification: changeCheck,
        report: buildReport(run, verifications, changeCheck),
      }
    }
    if (anyArtifact) {
      return {
        status: FINAL_STATUS.FAILED,
        phase: 'failed',
        endReason: 'verification-failed',
        endNote: '有产出，但验收没通过：' + verifications.filter((item) => !item.ok).map((item) => item.path + '（' + item.reason + '）').join('；'),
        action,
        verifications,
        changeVerification: changeCheck,
        report: null,
      }
    }
    if (changeCheck.ok) {
      return {
        status: FINAL_STATUS.COMPLETED,
        phase: 'completed',
        endReason: 'project-changes-verified',
        endNote: changeCheck.tests.length
          ? '项目改动与测试结果都核对过了。'
          : '项目改动已核对；这次没有测试输出。',
        action,
        verifications: [],
        changeVerification: changeCheck,
        report: buildReport(run, [], changeCheck),
      }
    }
    if (changeCheck.anyChange && changeCheck.testFailures > 0) {
      return {
        status: FINAL_STATUS.FAILED,
        phase: 'failed',
        endReason: 'tests-failed',
        endNote: '有项目改动，但测试没通过：' + changeCheck.tests.filter((test) => !test.ok).map((test) => test.command).slice(0, 3).join('；'),
        action,
        verifications: [],
        changeVerification: changeCheck,
        report: null,
      }
    }
    return {
      status: FINAL_STATUS.FAILED,
      phase: 'failed',
      endReason: 'no-deliverable',
      endNote: '这次说要动手，但没有产生可核对的成果（没有文件、没有改动）。我没有把它算成完成。',
      action,
      verifications: [],
      changeVerification: changeCheck,
      report: null,
    }
  }

  // answer / plan / ask：没有文件是正常的；真实依据来自理解块与工具结果。
  const hasUnderstanding = Boolean(run?.understanding?.headline)
  return {
    status: FINAL_STATUS.ANSWERED,
    phase: 'completed',
    endReason: hasUnderstanding ? 'answered' : 'answered-without-understanding',
    endNote: hasUnderstanding
      ? ''
      : run?.understandingInvalid
        ? '这次的结构化理解没有解析成功（' + run.understandingInvalid + '），所以只算答复，不算完成。'
        : '这次没有留下结构化理解，所以只算答复，不算完成。',
    action,
    verifications,
    report: null,
  }
}

function buildReport(run, verifications, changeCheck = null) {
  const steps = Array.isArray(run?.steps) ? run.steps : []
  return {
    goal: run?.goal ?? null,
    did: steps.filter((step) => step.status !== 'failed').map((step) => ({ verb: step.verb, target: step.target })),
    failed: steps.filter((step) => step.status === 'failed').map((step) => ({ verb: step.verb, target: step.target, error: step.error })),
    artifacts: verifications.map((item) => ({ path: item.path, ok: item.ok, size: item.size, sha256: item.sha256 })),
    changes: changeCheck ? { git: changeCheck.git, tests: changeCheck.tests } : null,
    understanding: run?.understanding ?? null,
    next: run?.understanding?.next ?? null,
  }
}

/**
 * 回流候选（P1）：只生成 draft，不自动写入任何地方。
 * 来源必须能指回本次 run 的真实步骤/理解/成果。
 */
export function buildCandidates(run) {
  const candidates = []
  const understanding = run?.understanding
  if (!understanding || !understanding.headline) return candidates
  const sources = []
  for (const step of Array.isArray(run?.steps) ? run.steps : []) {
    if (step.status === 'ok' && (step.name === 'shengluo_reality' || step.name === 'shengluo_knowledge' || step.name === 'shengluo_conversation')) {
      sources.push({ type: step.name === 'shengluo_knowledge' ? 'knowledge' : 'reality', ref: step.callId })
    }
  }
  const artifacts = Array.isArray(run?.artifacts) ? run.artifacts : []
  for (const artifact of artifacts) sources.push({ type: 'artifact', ref: artifact.path })
  const knowledgeUsed = (Array.isArray(run?.steps) ? run.steps : []).some((step) => step.name === 'shengluo_knowledge' && step.status === 'ok')
  const detail = {
    known: understanding.known,
    inference: understanding.inference,
    unknown: understanding.unknown,
    next: understanding.next,
  }
  candidates.push({
    id: 'cand-' + String(run?.runId ?? 'run') + '-1',
    runId: run?.runId ?? null,
    kind: understanding.action === 'execute' ? 'experience' : 'insight',
    use: understanding.action === 'execute' ? 'project-experience' : 'owner-confirmed-insight',
    status: 'draft',
    content: understanding.headline,
    detail,
    sources,
    target: null,
  })
  if (knowledgeUsed) {
    candidates.push({
      id: 'cand-' + String(run?.runId ?? 'run') + '-2',
      runId: run?.runId ?? null,
      kind: 'knowledge',
      use: 'knowledge-to-mki',
      status: 'blocked',
      content: understanding.headline,
      detail,
      sources: sources.filter((source) => source.type === 'knowledge'),
      target: { kind: 'mki', connected: false, label: 'MKI（未连接）' },
    })
  }
  return candidates
}
