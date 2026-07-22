import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import { ApiError, resetPassword } from '../lib/api';
import { useCurrentUser } from '../lib/auth-context';
import './AuthLayout.css';

// Supabase's recovery-link redirect appends the session as a URL fragment
// (#access_token=...&refresh_token=...&type=recovery), not a query string,
// since fragments never reach the server — read it once on first render,
// not inside an effect, so a later re-render (e.g. after React Router
// strips the hash) can't lose it.
function readAccessTokenFromHash(): string | null {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  return new URLSearchParams(hash).get('access_token');
}

export default function ResetPassword() {
  const navigate = useNavigate();
  const { setUser } = useCurrentUser();
  const [accessToken] = useState<string | null>(() => readAccessTokenFromHash());
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }

    if (!accessToken) return;

    setSubmitting(true);
    try {
      const result = await resetPassword({ accessToken, newPassword });
      if (result.status === 'signed_in') {
        setUser(result.user);
        navigate('/projects');
      } else {
        navigate('/login');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.fieldErrors?.[0]?.message ?? err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
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
        {!accessToken ? (
          <>
            <h1 className="auth-title">This link is invalid or has expired</h1>
            <div className="auth-subtitle">Request a new password reset link and try again.</div>
            <div className="auth-footer">
              <Link to="/forgot-password">Request a new link</Link>
            </div>
          </>
        ) : (
          <>
            <h1 className="auth-title">Set a new password</h1>
            <div className="auth-subtitle">Choose a new password for your account.</div>

            <form className="auth-fields" onSubmit={handleSubmit}>
              {error && <div className="auth-error" role="alert">{error}</div>}
              <div className="auth-field">
                <label htmlFor="reset-new-password">New password</label>
                <input
                  id="reset-new-password"
                  className="auth-input"
                  type="password"
                  placeholder="••••••••"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={10}
                  required
                />
              </div>
              <div className="auth-field">
                <label htmlFor="reset-confirm-password">Confirm new password</label>
                <input
                  id="reset-confirm-password"
                  className="auth-input"
                  type="password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={10}
                  required
                />
              </div>

              <button type="submit" className="auth-submit" disabled={submitting}>
                {submitting ? 'Updating…' : 'Update password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
