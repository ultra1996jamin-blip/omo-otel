// Tracks, per session, whether the `skill` tool (tools/skill/constants.ts's
// TOOL_NAME) has been invoked at least once — used to tag gen_ai.completion
// spans/context-usage metrics with a low-cardinality gen_ai.skill_used
// dimension, so Grafana can compare context growth with vs. without skill
// usage (an A/B-style question) instead of only ever seeing an aggregate.
const sessionsWithSkillUsage = new Set<string>()

export function markSessionUsedSkill(sessionID: string): void {
  sessionsWithSkillUsage.add(sessionID)
}

export function hasSessionUsedSkill(sessionID: string): boolean {
  return sessionsWithSkillUsage.has(sessionID)
}

export function clearSessionSkillUsage(sessionID: string): void {
  sessionsWithSkillUsage.delete(sessionID)
}

export function clearAllSessionSkillUsage(): void {
  sessionsWithSkillUsage.clear()
}
