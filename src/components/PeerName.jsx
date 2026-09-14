import { useAlias } from '../hooks/useAliasClock'
import { peerAlias } from '../lib/alias'

// Another person's rotating alias, as a leaf.
//
// It exists so a big component can put an aliased name on screen WITHOUT
// subscribing itself to the alias clock. `Shell` renders the game-invite
// banner; had it called useAlias() directly, every 30-minute bucket turnover
// would re-render the whole pager and hand CameraScreen and Stories fresh
// inline callbacks — the same shape of bug that made SnapMap refetch every
// location on each render. The subscription stops here instead.
//
// Never pass a name through this expecting concealment from someone who knows
// the pair: the alias is derived from the name. It raises the cost of a glance.
export default function PeerName({ profile, fallback = 'Your friend' }) {
  const alias = useAlias()
  return <>{peerAlias(alias, profile, fallback)}</>
}
