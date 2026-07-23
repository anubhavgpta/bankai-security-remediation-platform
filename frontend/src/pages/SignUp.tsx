import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import GithubIcon from '../components/GithubIcon';
import GoogleIcon from '../components/GoogleIcon';
import { ApiError, signup, ssoAuthorizeUrl } from '../lib/api';
import { useCurrentUser } from '../lib/auth-context';
import './AuthLayout.css';

export default function SignUp() {
  const navigate = useNavigate();
  const { setUser } = useCurrentUser();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);

    try {
      const result = await signup({ fullName, email, password });
      if (result.status === 'confirmation_required') {
        setNotice(result.message);
        return;
      }
      setUser(result.user);
      navigate('/onboarding');
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
        <h1 className="auth-title">Create your account</h1>
        <div className="auth-subtitle">Start triaging vulnerabilities with Bankai.</div>

        {notice ? (
          <div className="auth-notice" role="status">{notice}</div>
        ) : (
          <>
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
                <label htmlFor="signup-name">Full name</label>
                <input
                  id="signup-name"
                  className="auth-input"
                  type="text"
                  placeholder="Your name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </div>
              <div className="auth-field">
                <label htmlFor="signup-email">Work email</label>
                <input
                  id="signup-email"
                  className="auth-input"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="auth-field">
                <label htmlFor="signup-password">Password</label>
                <input
                  id="signup-password"
                  className="auth-input"
                  type="password"
                  placeholder="Create a password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={10}
                  required
                />
              </div>

              <button type="submit" className="auth-submit" disabled={submitting}>
                {submitting ? 'Creating account…' : 'Create account'}
              </button>
            </form>
          </>
        )}

        <div className="auth-fineprint">
          By creating an account you agree to Bankai&apos;s{' '}
          <Link to="/terms" className="auth-fineprint-link">Terms of Service</Link> and{' '}
          <Link to="/privacy" className="auth-fineprint-link">Privacy Policy</Link>.
        </div>
        <div className="auth-footer">
          Already have an account? <Link to="/login">Log in</Link>
        </div>
      </div>
    </div>
  );
}
