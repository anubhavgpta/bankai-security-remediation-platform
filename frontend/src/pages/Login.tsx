import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import { ApiError, login } from '../lib/api';
import './AuthLayout.css';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await login({ email, password });
      navigate('/projects');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.fieldErrors?.[0]?.message ?? err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-brand">
        <img src={bankaiMark} alt="Bankai" className="auth-brand-mark" />
        <img src={bankaiWordmark} alt="BANKAI" className="auth-brand-wordmark" />
      </div>

      <div className="auth-card">
        <h1 className="auth-title">Log in</h1>
        <div className="auth-subtitle">Sign in to continue to Bankai.</div>

        <form className="auth-fields" onSubmit={handleSubmit}>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <div className="auth-field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              className="auth-input"
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="auth-field">
            <div className="auth-field-row">
              <label htmlFor="login-password">Password</label>
              <a href="#forgot" onClick={(e) => e.preventDefault()}>Forgot password?</a>
            </div>
            <input
              id="login-password"
              className="auth-input"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? 'Logging in…' : 'Log in'}
          </button>
        </form>

        <div className="auth-footer">
          Don&apos;t have an account? <Link to="/signup">Sign up</Link>
        </div>
      </div>
    </div>
  );
}
