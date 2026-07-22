import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import GithubIcon from '../components/GithubIcon';
import GoogleIcon from '../components/GoogleIcon';
import { ApiError, login, ssoAuthorizeUrl } from '../lib/api';
import { useCurrentUser } from '../lib/auth-context';
import './AuthLayout.css';

export default function Login() {
  const navigate = useNavigate();
  const { setUser } = useCurrentUser();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(
    searchParams.get('sso_error') ? 'Could not sign you in. Please try again.' : null,
  );
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await login({ email, password });
      setUser(result.user);
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

        <div className="auth-oauth-row">
          <button type="button" className="auth-oauth-btn" onClick={() => { window.location.href = ssoAuthorizeUrl('google'); }}>
            <GoogleIcon size={16} />
            Continue with Google
          </button>
          <button type="button" className="auth-oauth-btn" onClick={() => { window.location.href = ssoAuthorizeUrl('github'); }}>
            <GithubIcon size={16} />
            Continue with GitHub
          </button>
          <div className="auth-oauth-note">Also connects your repos for scanning</div>
        </div>

        <div className="auth-divider">or</div>

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
              <Link to="/forgot-password">Forgot password?</Link>
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
