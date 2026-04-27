import { Component, ErrorInfo, ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Catch errors before React mounts (module-level crashes, Firebase init failures)
window.addEventListener('error', (e) => {
  const root = document.getElementById('root');
  if (root && root.childElementCount === 0) {
    root.innerHTML = `
      <div style="height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;font-family:sans-serif">
        <div style="text-align:center;max-width:480px;padding:2rem">
          <h1 style="color:#1e293b;font-size:1.25rem;margin-bottom:.5rem">Application Error</h1>
          <p style="color:#64748b;font-size:.875rem;margin-bottom:1rem">${e.message}</p>
          <p style="color:#94a3b8;font-size:.75rem">Check that all environment variables are configured in Coolify.</p>
          <button onclick="location.reload()" style="margin-top:1rem;padding:.5rem 1.25rem;background:#4f46e5;color:#fff;border:none;border-radius:.375rem;cursor:pointer;font-size:.875rem">Reload</button>
        </div>
      </div>`;
  }
});

class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('App error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex items-center justify-center bg-slate-50">
          <div className="text-center max-w-md p-8">
            <h1 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h1>
            <p className="text-sm text-slate-500 mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 bg-indigo-600 text-white rounded-md text-sm font-semibold hover:bg-indigo-700"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
