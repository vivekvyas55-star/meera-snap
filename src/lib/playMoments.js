export const MISSIONS = [
  'Make them laugh with a deliberately terrible joke.',
  'Notice one small thing they did and thank them for it.',
  'Find something in your day that reminds you of them.',
  'Invent a ridiculous name for your imaginary band.',
  'Send a song that matches a happy memory together.',
  'Describe your day using only three emojis.',
  'Offer them a tiny choice: a song, a joke or a compliment.',
  'Tell them about a small win you would usually keep to yourself.',
]
export const DATE_IDEAS = [
  'Make a snack together, or compare your snacks on a call.',
  'Take a ten-minute walk and swap one thing you noticed.',
  'Pick a song each and have a tiny listening party.',
  'Draw portraits of each other in two minutes.',
  'Have a cozy tea break with phones put aside.',
  'Choose a film trailer each and vote on movie night.',
  'Build an imaginary holiday with a pretend budget.',
  'Share a childhood story neither of you has heard.',
]
export const DRAW_WORDS = ['rocket', 'penguin', 'umbrella', 'pizza', 'cactus', 'bicycle', 'castle', 'octopus', 'teapot', 'rainbow', 'robot', 'sunflower']
export function nextIdea(items, current, random = Math.random) {
  const choices = items.filter(item => item !== current)
  if (!choices.length) return items[0] || ''
  return choices[Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)))]
}
export function normalizePoint(x, y, rect) {
  return [Math.max(0, Math.min(1, (x - rect.left) / (rect.width || 1))), Math.max(0, Math.min(1, (y - rect.top) / (rect.height || 1)))]
}
