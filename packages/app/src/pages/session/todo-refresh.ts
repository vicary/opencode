type State = {
  active: boolean
  blocked: boolean
}

export const shouldRefresh = (next: State, prev?: State) => {
  if (!prev) return next.active || next.blocked
  if (next.blocked !== prev.blocked && next.blocked) return true
  if (next.blocked) return false
  if (next.active && (next.active !== prev.active || next.blocked !== prev.blocked)) return true
  return false
}
