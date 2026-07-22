import { useState } from 'react';
import { Link } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import { ApiError, forgotPassword } from '../lib/api';
import './AuthLayout.css';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await forgotPassword(email);
      setNotice(result.message);
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
        <h1 className="auth-title">Forgot your password?</h1>
        <div className="auth-subtitle">Enter your email and we&apos;ll send you a link to reset it.</div>

        {notice ? (
          <div className="auth-notice" role="status">{notice}</div>
        ) : (
          <form className="auth-fields" onSubmit={handleSubmit}>
            {error && <div className="auth-error" role="alert">{error}</div>}
            <div className="auth-field">
              <label htmlFor="forgot-email">Email</label>
              <input
                id="forgot-email"
                className="auth-input"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <button type="submit" className="auth-submit" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        <div className="auth-footer">
          <Link to="/login">Back to log in</Link>
        </div>
      </div>
    </div>
  );
}
