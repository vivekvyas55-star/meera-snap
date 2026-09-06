export const compareMessages = (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
export function mergeMessages(current, incoming) {
  const byId = new Map(current.map(m => [m.id, m]))
  incoming.forEach(m => byId.set(m.id, m))
  return [...byId.values()].sort(compareMessages)
}
