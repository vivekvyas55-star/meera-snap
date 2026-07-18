// A stand-in for Bitmoji: a stable colour derived from the profile's stored hue
// plus the first letter of the name.
export default function Avatar({ profile, size = 'md', ring }) {
  const hue = profile?.avatar_hue ?? 45
  const letter = (profile?.display_name || profile?.username || '?').trim().charAt(0).toUpperCase()

  const circle = (
    <div
      className={`avatar${size === 'sm' ? ' sm' : size === 'lg' ? ' lg' : ''}`}
      style={{ background: `linear-gradient(140deg, hsl(${hue} 85% 58%), hsl(${(hue + 40) % 360} 85% 46%))` }}
      aria-label={profile?.username}
    >
      {letter}
    </div>
  )

  if (!ring) return circle
  return <div className={`ring ${ring}`}>{circle}</div>
}
