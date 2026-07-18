// A stand-in for Bitmoji: either an emoji the user picked, or a stable
// colour + first letter derived from the profile's stored hue.
export default function Avatar({ profile, size = 'md', ring }) {
  const hue = profile?.avatar_hue ?? 45
  const emoji = profile?.avatar_emoji
  const letter = (profile?.display_name || profile?.username || '?').trim().charAt(0).toUpperCase()

  const circle = (
    <div
      className={`avatar${size === 'sm' ? ' sm' : size === 'lg' ? ' lg' : ''}`}
      style={{
        background: emoji
          ? '#f1f1f3'
          : `linear-gradient(140deg, hsl(${hue} 85% 58%), hsl(${(hue + 40) % 360} 85% 46%))`,
      }}
      aria-label={profile?.username}
    >
      {emoji || letter}
    </div>
  )

  if (!ring) return circle
  return <div className={`ring ${ring}`}>{circle}</div>
}
