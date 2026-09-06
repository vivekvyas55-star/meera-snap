import { Component } from 'react'

// Without this, a lazy chunk that 404s — routine when a client that has been
// open across a redeploy tries to load Chat, or simply when offline — throws
// past the root and unmounts the whole app to a white page. The only recovery
// was force-quitting the PWA.
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="app">
        <div className="empty" role="alert">
          <div className="empty-symbol">!</div>
          <h2>Something went wrong</h2>
          <p>Meera hit an error it couldn’t recover from. Reloading usually fixes it.</p>
          <button className="btn-dark" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
