import { useState } from 'react';
import { Link } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import { ApiError, changePassword, updateProfile } from '../lib/api';
import { getAvatarStyle, getDisplayName, getInitials, useCurrentUser } from '../lib/auth-context';
import './AccountSettings.css';
import './NewProject.css';

export default function AccountSettings() {
  const { user, setUser } = useCurrentUser();

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileError(null);
    setProfileSuccess(false);

    if (!fullName.trim()) {
      setProfileError('Full name is required');
      return;
    }

    setSavingProfile(true);
    try {
      const { user: updated } = await updateProfile({ fullName });
      setUser(updated);
      setProfileSuccess(true);
    } catch (err) {
      setProfileError(err instanceof ApiError ? (err.fieldErrors?.[0]?.message ?? err.message) : 'Something went wrong. Please try again.');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }

    setSavingPassword(true);
    try {
      await changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess(true);
    } catch (err) {
      setPasswordError(err instanceof ApiError ? (err.fieldErrors?.[0]?.message ?? err.message) : 'Something went wrong. Please try again.');
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="new-project-page">
      <div className="new-project-topbar">
        <div className="new-project-brand">
          <img src={bankaiMark} alt="Bankai" className="new-project-brand-mark" />
          <img src={bankaiWordmark} alt="BANKAI" className="new-project-brand-wordmark" />
        </div>
        <div className="avatar-ring" style={getAvatarStyle(user)}>{getInitials(user)}</div>
      </div>

      <main className="new-project-main">
        <div className="new-project-breadcrumb">
          <Link to="/projects" className="new-project-breadcrumb-link">Bankai</Link>
          <span className="new-project-breadcrumb-sep">›</span>
          <span className="new-project-breadcrumb-current">Account settings</span>
        </div>
        <div className="new-project-divider" />

        <div className="new-project-eyebrow">Account</div>
        <h1 className="new-project-title">Account settings</h1>
        <div className="new-project-subtitle">Manage your profile and password. This applies to your account, not any one project.</div>

        <form onSubmit={handleSaveProfile}>
          <section className="new-project-section">
            <h2 className="new-project-section-title">Profile</h2>

            <div className="account-settings-profile-row">
              <div className="avatar-ring" style={getAvatarStyle(user)}>{getInitials(user)}</div>
              <div>
                <div className="account-settings-profile-name">{getDisplayName(user)}</div>
                {user?.email && <div className="account-settings-profile-email">{user.email}</div>}
              </div>
            </div>

            {profileError && <div className="new-project-error" role="alert">{profileError}</div>}
            {profileSuccess && <div className="account-settings-success" role="status">Profile updated.</div>}

            <div className="new-project-field-stack">
              <div className="new-project-field">
                <label htmlFor="account-name">Full name</label>
                <input
                  id="account-name"
                  type="text"
                  className="new-project-input"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </div>
              <div className="new-project-field">
                <label htmlFor="account-email">Email</label>
                <input id="account-email" type="email" className="new-project-input" value={user?.email ?? ''} disabled />
                <div className="account-settings-hint">Contact support to change the email on your account.</div>
              </div>
            </div>
          </section>

          <div className="new-project-actions">
            <button type="submit" className="new-project-create-btn" disabled={savingProfile}>
              {savingProfile ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </form>

        <form onSubmit={handleChangePassword}>
          <section className="new-project-section" style={{ marginTop: 28 }}>
            <h2 className="new-project-section-title">Password</h2>

            {passwordError && <div className="new-project-error" role="alert">{passwordError}</div>}
            {passwordSuccess && <div className="account-settings-success" role="status">Password changed.</div>}

            <div className="new-project-field-stack">
              <div className="new-project-field">
                <label htmlFor="current-password">Current password</label>
                <input
                  id="current-password"
                  type="password"
                  className="new-project-input"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </div>
              <div className="new-project-field">
                <label htmlFor="new-password">New password</label>
                <input
                  id="new-password"
                  type="password"
                  className="new-project-input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={10}
                  required
                />
              </div>
              <div className="new-project-field">
                <label htmlFor="confirm-password">Confirm new password</label>
                <input
                  id="confirm-password"
                  type="password"
                  className="new-project-input"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={10}
                  required
                />
              </div>
            </div>
          </section>

          <div className="new-project-actions">
            <button type="submit" className="new-project-create-btn" disabled={savingPassword}>
              {savingPassword ? 'Updating…' : 'Change password'}
            </button>
            <Link to="/projects" className="new-project-cancel-link">Back to projects</Link>
          </div>
        </form>
      </main>
    </div>
  );
}
