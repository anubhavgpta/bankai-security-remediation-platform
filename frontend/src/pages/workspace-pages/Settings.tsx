import { useState } from 'react';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import './Settings.css';

const SLA_TIERS = [
  { label: 'Critical', days: 7, badgeClass: 'ws-badge--critical' },
  { label: 'High', days: 30, badgeClass: 'ws-badge--high' },
  { label: 'Medium', days: 90, badgeClass: 'ws-badge--medium' },
  { label: 'Low', days: 180, badgeClass: 'ws-badge--low' },
];

const NOTIF_DEFS = [
  { key: 'slaBreach', title: 'SLA breach alerts', desc: 'Notify me the moment a CVIT crosses its SLA deadline.', on: true },
  { key: 'newTicket', title: 'New ticket created', desc: 'Notify me when Bankai opens a Jira ticket from a new delta row.', on: true },
  { key: 'weeklyDigest', title: 'Weekly digest', desc: 'A Monday summary of triage results and open SLA risk.', on: true },
  { key: 'slackMirror', title: 'Mirror to Slack', desc: 'Send the same alerts to #sec-remediation.', on: false },
];

const TEAM = [
  { name: 'Abhinav Gupta', email: 'abhiyug5@gmail.com', initials: 'AG', avatarBg: '#22C55E', role: 'Admin', roleBorder: '#93C5FD', roleColor: '#1D4ED8', access: 'Full access' },
  { name: 'Priya Kapoor', email: 'priya.k@identityco.io', initials: 'PK', avatarBg: '#2563EB', role: 'Editor', roleBorder: '#86EFAC', roleColor: '#15803D', access: 'Triage + tickets' },
  { name: 'Sam Reyes', email: 'sam.reyes@identityco.io', initials: 'SR', avatarBg: '#7C3AED', role: 'Editor', roleBorder: '#86EFAC', roleColor: '#15803D', access: 'Triage + tickets' },
  { name: 'Maya Torres', email: 'maya.torres@identityco.io', initials: 'MT', avatarBg: '#EA580C', role: 'Viewer', roleBorder: '#D1D1D6', roleColor: '#3A3A3C', access: 'Read only' },
];

export default function Settings() {
  const [jiraConnected, setJiraConnected] = useState(true);
  const [notifs, setNotifs] = useState<Record<string, boolean>>(
    Object.fromEntries(NOTIF_DEFS.map((d) => [d.key, d.on]))
  );

  return (
    <main className="ws-page ws-page--settings">
      <WorkspaceBreadcrumb current="Settings" />
      <div className="ws-divider" />

      <section className="ws-card settings-section">
        <div className="ws-card-eyebrow">Account</div>
        <h2 className="ws-card-title">Profile</h2>
        <div className="settings-profile-row">
          <div className="settings-profile-avatar">AG</div>
          <div className="settings-profile-info">
            <div className="settings-profile-name">Abhinav Gupta</div>
            <div className="settings-profile-email">abhiyug5@gmail.com</div>
          </div>
          <span className="settings-role-badge">Workspace Admin</span>
          <button className="ws-btn ws-btn-secondary">Edit profile</button>
        </div>
      </section>

      <section className="ws-card settings-section">
        <div className="settings-section-header">
          <div>
            <div className="ws-card-eyebrow">Integration</div>
            <h2 className="settings-h2">Jira</h2>
          </div>
          <span className="ws-dot-status" style={{ color: jiraConnected ? '#15803D' : '#B91C1C' }}>
            <span className="ws-dot" style={{ background: jiraConnected ? '#22C55E' : '#EF4444' }} />
            {jiraConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div className="settings-jira-grid">
          <div>
            <div className="settings-field-label">Site</div>
            <div className="settings-field-value">identityco.atlassian.net</div>
          </div>
          <div>
            <div className="settings-field-label">Project key</div>
            <div className="settings-field-value ws-mono">BNK</div>
          </div>
        </div>
        <div className="settings-jira-actions">
          <button
            className={`ws-btn ${jiraConnected ? 'ws-btn-danger-outline' : 'ws-btn-primary'}`}
            onClick={() => setJiraConnected((v) => !v)}
          >
            {jiraConnected ? 'Disconnect' : 'Reconnect'}
          </button>
          <span className="settings-jira-synced">Last synced today 07:40</span>
        </div>
      </section>

      <section className="ws-card settings-section">
        <div className="ws-card-eyebrow">Remediation</div>
        <h2 className="settings-h2" style={{ marginBottom: 6 }}>SLA policy</h2>
        <div className="ws-card-hint">
          Days allowed to remediate a CVIT before it&rsquo;s marked Missed SLA. &ldquo;Approaching&rdquo; fires inside the last 20% of the window.
        </div>
        <div className="settings-sla-grid">
          {SLA_TIERS.map((tier) => (
            <div key={tier.label} className="ws-stat-tile">
              <span className={`ws-badge ${tier.badgeClass}`} style={{ fontSize: 10.5, padding: '3px 10px' }}>{tier.label}</span>
              <div className="settings-sla-value-row">
                <span className="settings-sla-value">{tier.days}</span>
                <span className="settings-sla-unit">days</span>
              </div>
            </div>
          ))}
        </div>
        <button className="ws-btn ws-btn-secondary" style={{ marginTop: 16 }}>Edit thresholds</button>
      </section>

      <section className="ws-card settings-section">
        <div className="ws-card-eyebrow">Alerts</div>
        <h2 className="settings-h2">Notifications</h2>
        <div>
          {NOTIF_DEFS.map((d) => {
            const on = notifs[d.key];
            return (
              <div key={d.key} className="settings-notif-row">
                <div className="settings-notif-info">
                  <div className="settings-notif-title">{d.title}</div>
                  <div className="settings-notif-desc">{d.desc}</div>
                </div>
                <button
                  className={`ws-toggle ${on ? 'ws-toggle--on' : ''}`}
                  onClick={() => setNotifs((prev) => ({ ...prev, [d.key]: !prev[d.key] }))}
                >
                  <span className="ws-toggle-knob" />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="ws-card">
        <div className="settings-team-header">
          <div>
            <div className="ws-card-eyebrow">Access</div>
            <h2 className="settings-h2">Team</h2>
          </div>
          <button className="ws-btn ws-btn-primary" style={{ padding: '9px 18px', fontSize: 13 }}>Invite member</button>
        </div>
        <div className="settings-team-head">
          <span>Member</span><span>Role</span><span className="ws-col-right">Access</span>
        </div>
        {TEAM.map((m) => (
          <div key={m.email} className="settings-team-row">
            <span className="settings-team-member">
              <span className="ws-avatar-chip" style={{ background: m.avatarBg }}>{m.initials}</span>
              <span className="settings-team-member-text">
                <span className="settings-team-member-name">{m.name}</span>
                <span className="settings-team-member-email">{m.email}</span>
              </span>
            </span>
            <span><span className="ws-badge ws-badge--outline" style={{ borderColor: m.roleBorder, color: m.roleColor }}>{m.role}</span></span>
            <span className="ws-col-right settings-team-access">{m.access}</span>
          </div>
        ))}
      </section>
    </main>
  );
}
