import { useCallback, useEffect, useRef, useState } from 'react'
import { listSharedPlay } from '../lib/sharedPlay'

export function useSharedPlay(other) {
  const [state, setState] = useState({ rows: [], loading: true, error: '', unavailable: false })
  const generation = useRef(0)
  const invalidate = useCallback(() => { generation.current++ }, [])
  const refresh = useCallback(async () => {
    const version = ++generation.current
    if (!other) { setState({ rows: [], loading: false, error: '', unavailable: false }); return }
    try {
      const rows = await listSharedPlay(other)
      if (generation.current === version) setState({ rows: rows || [], loading: false, error: '', unavailable: false })
    } catch (error) {
      if (generation.current === version) setState(previous => ({ ...previous, loading: false, unavailable: error.code === 'PGRST202', error: error.code === 'PGRST202' ? '' : 'Could not refresh shared activities. Try again.' }))
    }
  }, [other])
  useEffect(() => {
    setState({ rows: [], loading: true, error: '', unavailable: false })
    refresh()
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    const timer = setInterval(onVisible, 6000)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    return () => { invalidate(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onVisible) }
  }, [refresh, invalidate])
  return { ...state, refresh }
}
