import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import GithubIcon from '../../components/GithubIcon';
import RepoPicker from '../../components/RepoPicker';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import {
  ApiError,
  connectGithub,
  connectGithubFromAccount,
  connectJira,
  deleteProject,
  disconnectGithub,
  disconnectJira,
  getGithubAccountStatus,
  getGithubConnection,
  getJiraConnection,
  getScan,
  inviteMember,
  listMembers,
  removeMember,
  revokeInvite,
  scanGithubRepo,
  updateMemberRole,
  updateProjectSettings,
  updateSlaPolicy,
  type GithubAccountStatus,
  type GithubConnection,
  type GithubUserRepo,
  type JiraConnection,
  type MemberRole,
  type PendingProjectInvite,
  type ProjectMember,
  type Scan,
  type SlaPolicyDays,
} from '../../lib/api';
import { getAvatarStyle, getDisplayName, getInitials, useCurrentUser } from '../../lib/auth-context';
import { canManageProject } from '../../lib/roles';
import { useProject } from '../../lib/project-context';
import './Settings.css';

const SLA_TIERS: { key: keyof SlaPolicyDays; label: string; badgeClass: string }[] = [
  { key: 'critical', label: 'Critical', badgeClass: 'ws-badge--critical' },
  { key: 'high', label: 'High', badgeClass: 'ws-badge--high' },
  { key: 'medium', label: 'Medium', badgeClass: 'ws-badge--medium' },
  { key: 'low', label: 'Low', badgeClass: 'ws-badge--low' },
];

const NOTIF_DEFS = [
  { key: 'slaBreach', title: 'SLA breach alerts', desc: 'Notify me the moment a CVIT crosses its SLA deadline.', on: true },
  { key: 'newTicket', title: 'New ticket created', desc: 'Notify me when Bankai opens a Jira ticket from a new delta row.', on: true },
  { key: 'weeklyDigest', title: 'Weekly digest', desc: 'A Monday summary of triage results and open SLA risk.', on: true },
  { key: 'slackMirror', title: 'Mirror to Slack', desc: 'Send the same alerts to #sec-remediation.', on: false },
];

const ROLE_STYLE: Record<MemberRole, { border: string; color: string; access: string }> = {
  owner: { border: '#93C5FD', color: '#1D4ED8', access: 'Full access' },
  admin: { border: '#93C5FD', color: '#1D4ED8', access: 'Full access' },
  editor: { border: '#86EFAC', color: '#15803D', access: 'Triage + tickets' },
  viewer: { border: '#D1D1D6', color: '#3A3A3C', access: 'Read only' },
};

const AVATAR_COLORS = ['#22C55E', '#2563EB', '#7C3AED', '#EA580C', '#DB2777', '#0D9488', '#CA8A04'];

function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function inviteLink(token: string): string {
  return `${window.location.origin}/invites/${token}`;
}

function formatConnectedAt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function Settings() {
  const { project, refresh: refreshProject } = useProject();
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const [notifs, setNotifs] = useState<Record<string, boolean>>(
    Object.fromEntries(NOTIF_DEFS.map((d) => [d.key, d.on]))
  );

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [invites, setInvites] = useState<PendingProjectInvite[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberActionBusy, setMemberActionBusy] = useState<string | null>(null);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<MemberRole, 'owner'>>('editor');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [generatedInviteUrl, setGeneratedInviteUrl] = useState<string | null>(null);

  const [editingSla, setEditingSla] = useState(false);
  const [slaDraft, setSlaDraft] = useState<SlaPolicyDays | null>(null);
  const [slaSaving, setSlaSaving] = useState(false);
  const [slaError, setSlaError] = useState<string | null>(null);

  const [editingTeam, setEditingTeam] = useState(false);
  const [teamDraft, setTeamDraft] = useState('');
  const [teamSaving, setTeamSaving] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);

  const [jira, setJira] = useState<JiraConnection | null>(null);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [jiraConnectNote, setJiraConnectNote] = useState<string | null>(null);
  const [jiraFieldErrors, setJiraFieldErrors] = useState<Record<string, string>>({});
  const [site, setSite] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [projectKey, setProjectKey] = useState('');

  const [github, setGithub] = useState<GithubConnection | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubFieldErrors, setGithubFieldErrors] = useState<Record<string, string>>({});
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [justConnectedWebhookSecret, setJustConnectedWebhookSecret] = useState<string | null>(null);

  const [scan, setScan] = useState<Scan | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Read-only here — connecting/disconnecting the account-level GitHub
  // OAuth grant lives in AccountSettings.tsx (it's a per-user setting, not
  // a per-project one). This project's GitHub card only needs to know
  // whether one exists, to decide whether to default to the repo picker.
  const [githubAccount, setGithubAccount] = useState<GithubAccountStatus | null>(null);
  const [useManualPat, setUseManualPat] = useState(false);
  const [pickerBaseBranch, setPickerBaseBranch] = useState('');
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    getJiraConnection(project.id)
      .then((conn) => {
        if (!cancelled) setJira(conn);
      })
      .catch(() => {});
    getGithubConnection(project.id)
      .then((conn) => {
        if (!cancelled) setGithub(conn);
      })
      .catch(() => {});
    getGithubAccountStatus()
      .then((status) => {
        if (!cancelled) setGithubAccount(status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const handlePickRepo = async (picked: GithubUserRepo) => {
    if (!project) return;
    setPickerError(null);
    setPickerBusy(true);
    try {
      const conn = await connectGithubFromAccount(project.id, {
        repo: picked.fullName,
        baseBranch: pickerBaseBranch || undefined,
      });
      setGithub(conn);
      setJustConnectedWebhookSecret(conn.webhookSecret ?? null);
      setPickerBaseBranch('');
    } catch (err) {
      setPickerError(err instanceof ApiError ? err.message : 'Could not connect this repository. Please try again.');
    } finally {
      setPickerBusy(false);
    }
  };

  const loadMembers = () => {
    if (!project) return;
    listMembers(project.id)
      .then(({ members: fetchedMembers, invites: fetchedInvites }) => {
        setMembers(fetchedMembers);
        setInvites(fetchedInvites);
      })
      .catch(() => setMembersError('Could not load team members.'));
  };

  useEffect(() => {
    loadMembers();
  }, [project?.id]);

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const { inviteUrl } = await inviteMember(project.id, { email: inviteEmail, role: inviteRole });
      loadMembers();
      setGeneratedInviteUrl(inviteUrl);
      setInviteEmail('');
    } catch (err) {
      setInviteError(err instanceof ApiError ? (err.fieldErrors?.[0]?.message ?? err.message) : 'Could not create this invite.');
    } finally {
      setInviteBusy(false);
    }
  };

  const handleRoleChange = async (memberId: string, role: Exclude<MemberRole, 'owner'>) => {
    if (!project) return;
    setMemberActionBusy(memberId);
    try {
      await updateMemberRole(project.id, memberId, role);
      loadMembers();
    } finally {
      setMemberActionBusy(null);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!project) return;
    setMemberActionBusy(memberId);
    try {
      await removeMember(project.id, memberId);
      loadMembers();
    } finally {
      setMemberActionBusy(null);
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    if (!project) return;
    setMemberActionBusy(inviteId);
    try {
      await revokeInvite(project.id, inviteId);
      loadMembers();
    } finally {
      setMemberActionBusy(null);
    }
  };

  const handleConnect = async (e: FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setJiraError(null);
    setJiraFieldErrors({});
    setJiraConnectNote(null);
    setJiraLoading(true);
    try {
      const conn = await connectJira(project.id, { site, email, apiToken, projectKey: projectKey.toUpperCase() });
      setJira(conn);
      const notes = [
        conn.reconciled > 0 && `Linked ${conn.reconciled} ticket(s) to existing Jira issue(s) already in this project.`,
        conn.imported > 0 && `Imported ${conn.imported} finding(s)/ticket(s) from other Jira issue(s) using this connection.`,
      ].filter(Boolean);
      if (notes.length > 0) {
        setJiraConnectNote(notes.join(' '));
      }
      setSite('');
      setEmail('');
      setApiToken('');
      setProjectKey('');
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors?.length) {
        setJiraFieldErrors(Object.fromEntries(err.fieldErrors.map((f) => [f.path, f.message])));
      } else if (err instanceof ApiError) {
        setJiraError(err.message);
      } else {
        setJiraError('Something went wrong. Please try again.');
      }
    } finally {
      setJiraLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!project) return;
    setJiraLoading(true);
    try {
      const conn = await disconnectJira(project.id);
      setJira(conn);
    } finally {
      setJiraLoading(false);
    }
  };

  const handleConnectGithub = async (e: FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setGithubError(null);
    setGithubFieldErrors({});
    setGithubLoading(true);
    try {
      const conn = await connectGithub(project.id, { repo, token, baseBranch: baseBranch || undefined });
      setGithub(conn);
      setJustConnectedWebhookSecret(conn.webhookSecret ?? null);
      setRepo('');
      setToken('');
      setBaseBranch('');
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors?.length) {
        setGithubFieldErrors(Object.fromEntries(err.fieldErrors.map((f) => [f.path, f.message])));
      } else if (err instanceof ApiError) {
        setGithubError(err.message);
      } else {
        setGithubError('Something went wrong. Please try again.');
      }
    } finally {
      setGithubLoading(false);
    }
  };

  const handleDisconnectGithub = async () => {
    if (!project) return;
    setGithubLoading(true);
    try {
      const conn = await disconnectGithub(project.id);
      setGithub(conn);
      setJustConnectedWebhookSecret(null);
      setScan(null);
    } finally {
      setGithubLoading(false);
    }
  };

  const handleScanRepo = async () => {
    if (!project) return;
    setScanError(null);
    setScanBusy(true);
    try {
      const { scan: created } = await scanGithubRepo(project.id);
      setScan(created);
    } catch (err) {
      setScanError(err instanceof ApiError ? err.message : 'Could not start the scan. Please try again.');
    } finally {
      setScanBusy(false);
    }
  };

  // Polls the just-triggered scan until it leaves Queued/Processing, so the
  // user gets feedback here without needing to jump to Report Intake.
  useEffect(() => {
    if (!project || !scan || (scan.status !== 'Queued' && scan.status !== 'Processing')) return;
    const timer = setTimeout(() => {
      getScan(project.id, scan.id)
        .then(({ scan: updated }) => setScan(updated))
        .catch(() => {});
    }, 3000);
    return () => clearTimeout(timer);
  }, [project, scan]);

  const startEditingSla = () => {
    if (!project) return;
    setSlaDraft(project.slaPolicyDays);
    setSlaError(null);
    setEditingSla(true);
  };

  const cancelEditingSla = () => {
    setEditingSla(false);
    setSlaDraft(null);
    setSlaError(null);
  };

  const handleSaveSla = async (e: FormEvent) => {
    e.preventDefault();
    if (!project || !slaDraft) return;
    setSlaSaving(true);
    setSlaError(null);
    try {
      await updateSlaPolicy(project.id, slaDraft);
      refreshProject();
      setEditingSla(false);
      setSlaDraft(null);
    } catch (err) {
      setSlaError(err instanceof ApiError ? (err.fieldErrors?.[0]?.message ?? err.message) : 'Could not save the SLA policy.');
    } finally {
      setSlaSaving(false);
    }
  };

  const startEditingTeam = () => {
    if (!project) return;
    setTeamDraft(project.teamName ?? '');
    setTeamError(null);
    setEditingTeam(true);
  };

  const cancelEditingTeam = () => {
    setEditingTeam(false);
    setTeamDraft('');
    setTeamError(null);
  };

  const handleSaveTeam = async (e: FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setTeamSaving(true);
    setTeamError(null);
    try {
      await updateProjectSettings(project.id, { teamName: teamDraft.trim() });
      refreshProject();
      setEditingTeam(false);
    } catch (err) {
      setTeamError(err instanceof ApiError ? (err.fieldErrors?.[0]?.message ?? err.message) : 'Could not save the team name.');
    } finally {
      setTeamSaving(false);
    }
  };

  const handleDeleteProject = async (e: FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteProject(project.id, deleteConfirmText);
      navigate('/projects');
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Could not delete this project.');
      setDeleteBusy(false);
    }
  };

  return (
    <main className="ws-page ws-page--settings">
      <WorkspaceBreadcrumb current="Settings" />
      <div className="ws-divider" />

      <section className="ws-card settings-section">
        <div className="ws-card-eyebrow">Account</div>
        <h2 className="ws-card-title">Profile</h2>
        <div className="settings-profile-row">
          <div className="settings-profile-avatar" style={getAvatarStyle(user)}>{getInitials(user)}</div>
          <div className="settings-profile-info">
            <div className="settings-profile-name">{getDisplayName(user)}</div>
            {user?.email && <div className="settings-profile-email">{user.email}</div>}
          </div>
          {project && <span className="settings-role-badge" style={{ textTransform: 'capitalize' }}>{project.myRole}</span>}
          <Link to="/settings" className="ws-btn ws-btn-secondary">Edit profile</Link>
        </div>
      </section>

      <section className="ws-card settings-section">
        <div className="ws-card-eyebrow">Project</div>
        <h2 className="settings-h2" style={{ marginBottom: 6 }}>General</h2>
        <div className="ws-card-hint">The team name shown on Jira tickets Bankai creates from this project&rsquo;s findings.</div>

        {editingTeam ? (
          <form onSubmit={handleSaveTeam}>
            {teamError && <div className="settings-jira-error" role="alert">{teamError}</div>}
            <div className="settings-jira-field" style={{ marginTop: 12 }}>
              <label htmlFor="team-name" className="settings-field-label">Team name</label>
              <input
                id="team-name"
                type="text"
                className="settings-jira-input"
                value={teamDraft}
                onChange={(e) => setTeamDraft(e.target.value)}
                maxLength={120}
                placeholder="e.g. Identity Platform"
              />
            </div>
            <div className="settings-jira-actions" style={{ marginTop: 16 }}>
              <button type="submit" className="ws-btn ws-btn-primary" disabled={teamSaving}>
                {teamSaving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="ws-btn ws-btn-secondary" onClick={cancelEditingTeam} disabled={teamSaving}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <div style={{ marginTop: 12 }}>
              <div className="settings-field-label">Team name</div>
              <div className="settings-field-value">{project?.teamName || '—'}</div>
            </div>
            <button
              className="ws-btn ws-btn-secondary"
              style={{ marginTop: 16 }}
              onClick={startEditingTeam}
              disabled={!project || !canManageProject(project.myRole)}
              title={project && !canManageProject(project.myRole) ? 'Only admins can edit the team name.' : undefined}
            >
              Edit team name
            </button>
          </>
        )}
      </section>

      <section className="ws-card settings-section">
        <div className="settings-section-header">
          <div>
            <div className="ws-card-eyebrow">Integration</div>
            <h2 className="settings-h2">Jira</h2>
          </div>
          {jira && (
            <span className="ws-dot-status" style={{ color: jira.connected ? '#15803D' : '#B91C1C' }}>
              <span className="ws-dot" style={{ background: jira.connected ? '#22C55E' : '#EF4444' }} />
              {jira.connected ? 'Connected' : 'Disconnected'}
            </span>
          )}
        </div>

        {jira?.connected ? (
          <>
            {jiraConnectNote && <div className="settings-jira-synced" role="status">{jiraConnectNote}</div>}
            <div className="settings-jira-grid">
              <div>
                <div className="settings-field-label">Site</div>
                <div className="settings-field-value">{jira.site}</div>
              </div>
              <div>
                <div className="settings-field-label">Project key</div>
                <div className="settings-field-value ws-mono">{jira.projectKey}</div>
              </div>
            </div>
            <div className="settings-jira-actions">
              {project && canManageProject(project.myRole) && (
                <button className="ws-btn ws-btn-danger-outline" onClick={handleDisconnect} disabled={jiraLoading}>
                  Disconnect
                </button>
              )}
              {jira.connectedAt && (
                <span className="settings-jira-synced">Connected since {formatConnectedAt(jira.connectedAt)}</span>
              )}
            </div>
          </>
        ) : project && !canManageProject(project.myRole) ? (
          <div className="ws-card-hint">Only admins can connect Jira for this project.</div>
        ) : (
          <form onSubmit={handleConnect}>
            {jiraError && <div className="settings-jira-error" role="alert">{jiraError}</div>}
            <div className="ws-card-hint" style={{ marginBottom: 16 }}>
              New to Jira? <a href="https://www.atlassian.com/software/jira/free" target="_blank" rel="noreferrer">Create a free Jira site</a>, then{' '}
              <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">generate an API token</a> to connect it here.
            </div>
            <div className="settings-jira-grid">
              <div className="settings-jira-field">
                <label htmlFor="jira-site" className="settings-field-label">Site URL</label>
                <input
                  id="jira-site"
                  className="settings-jira-input"
                  placeholder="yoursite.atlassian.net"
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                  required
                />
                {jiraFieldErrors.site && <div className="settings-jira-field-error">{jiraFieldErrors.site}</div>}
              </div>
              <div className="settings-jira-field">
                <label htmlFor="jira-key" className="settings-field-label">Project key</label>
                <input
                  id="jira-key"
                  className="settings-jira-input"
                  style={{ textTransform: 'uppercase' }}
                  placeholder="BNK"
                  value={projectKey}
                  onChange={(e) => setProjectKey(e.target.value)}
                  required
                />
                {jiraFieldErrors.projectKey && <div className="settings-jira-field-error">{jiraFieldErrors.projectKey}</div>}
              </div>
              <div className="settings-jira-field">
                <label htmlFor="jira-email" className="settings-field-label">Email</label>
                <input
                  id="jira-email"
                  type="email"
                  className="settings-jira-input"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
                {jiraFieldErrors.email && <div className="settings-jira-field-error">{jiraFieldErrors.email}</div>}
              </div>
              <div className="settings-jira-field">
                <label htmlFor="jira-token" className="settings-field-label">API token</label>
                <input
                  id="jira-token"
                  type="password"
                  className="settings-jira-input"
                  placeholder="Paste your Atlassian API token"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  required
                />
                {jiraFieldErrors.apiToken && <div className="settings-jira-field-error">{jiraFieldErrors.apiToken}</div>}
              </div>
            </div>
            <div className="settings-jira-actions">
              <button type="submit" className="ws-btn ws-btn-primary" disabled={jiraLoading}>
                {jiraLoading ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="ws-card settings-section">
        <div className="settings-section-header">
          <div>
            <div className="ws-card-eyebrow">Integration</div>
            <h2 className="settings-h2" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <GithubIcon size={18} />
              GitHub
            </h2>
          </div>
          {github && (
            <span className="ws-dot-status" style={{ color: github.connected ? '#15803D' : '#B91C1C' }}>
              <span className="ws-dot" style={{ background: github.connected ? '#22C55E' : '#EF4444' }} />
              {github.connected ? 'Connected' : 'Disconnected'}
            </span>
          )}
        </div>

        {github?.connected ? (
          <>
            <div className="settings-jira-grid">
              <div>
                <div className="settings-field-label">Repository</div>
                <div className="settings-field-value ws-mono">{github.repo}</div>
              </div>
              <div>
                <div className="settings-field-label">Base branch</div>
                <div className="settings-field-value ws-mono">{github.defaultBranch}</div>
              </div>
            </div>

            {github.webhookRegistered ? (
              <div className="ws-card-hint" style={{ marginTop: 12 }}>
                <span className="ws-dot" style={{ background: '#22C55E', marginRight: 6 }} />
                Auto-rescans on push and PR-merge ticket updates: enabled — every push to {github.defaultBranch} triggers a
                new AI scan, and merging an AI fix's pull request automatically moves its ticket to Done.
              </div>
            ) : github.webhookUrl ? (
              <div className="settings-jira-error" style={{ marginTop: 12, background: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E' }}>
                Auto-rescan on push and PR-merge ticket updates aren't set up — this token couldn't create a webhook
                automatically. Add one manually in the repo's Settings → Webhooks: payload URL <code>{github.webhookUrl}</code>,
                content type <code>application/json</code>, events <code>push</code>, <code>pull_request</code>, and <code>workflow_run</code>
                {justConnectedWebhookSecret ? (
                  <>
                    , and secret <code>{justConnectedWebhookSecret}</code> (shown once — reconnect GitHub to generate a
                    new one if you lose it).
                  </>
                ) : (
                  <>
                    , and the secret shown when you connected (reconnect GitHub if you need a new one).
                  </>
                )}
              </div>
            ) : null}

            <div className="settings-jira-actions" style={{ marginTop: 12 }}>
              {project && canManageProject(project.myRole) && (
                <button
                  className="ws-btn ws-btn-secondary"
                  onClick={handleScanRepo}
                  disabled={scanBusy || scan?.status === 'Queued' || scan?.status === 'Processing'}
                >
                  {scan?.status === 'Queued' || scan?.status === 'Processing' ? 'Scanning…' : 'Scan repository now'}
                </button>
              )}
              {project && canManageProject(project.myRole) && (
                <button className="ws-btn ws-btn-danger-outline" onClick={handleDisconnectGithub} disabled={githubLoading}>
                  Disconnect
                </button>
              )}
              {github.connectedAt && (
                <span className="settings-jira-synced">Connected since {formatConnectedAt(github.connectedAt)}</span>
              )}
            </div>

            {scanError && <div className="settings-jira-error" role="alert" style={{ marginTop: 12 }}>{scanError}</div>}
            {scan && (
              <div className="ws-card-hint" style={{ marginTop: 12 }}>
                {scan.status === 'Queued' && 'Scan queued — waiting for the next available worker…'}
                {scan.status === 'Processing' && 'Scanning the repository with AI — this can take a few minutes for larger repos…'}
                {scan.status === 'Done' &&
                  `Scan complete: ${scan.findingCount ?? 0} finding(s) · ${scan.newDeltaCount} new · ${scan.changedCount} changed · ${scan.resolvedCount} resolved.`}
                {scan.status === 'Failed' && `Scan failed: ${scan.errorMessage ?? 'Unknown error.'}`}
              </div>
            )}
          </>
        ) : project && !canManageProject(project.myRole) ? (
          <div className="ws-card-hint">Only admins can connect GitHub for this project.</div>
        ) : githubAccount?.connected && !useManualPat ? (
          <div>
            <div className="ws-card-hint" style={{ marginBottom: 16 }}>
              Pick a repository from your connected GitHub account (@{githubAccount.login}). Bankai will scan it with
              AI, populate AI Triage with findings and detailed remediation guidance, and open a remediation branch
              for each one.
            </div>
            {pickerError && <div className="settings-jira-error" role="alert" style={{ marginBottom: 12 }}>{pickerError}</div>}
            <div className="settings-jira-field" style={{ marginBottom: 12 }}>
              <label htmlFor="picker-base-branch" className="settings-field-label">Base branch (optional)</label>
              <input
                id="picker-base-branch"
                className="settings-jira-input"
                placeholder="main"
                value={pickerBaseBranch}
                onChange={(e) => setPickerBaseBranch(e.target.value)}
                disabled={pickerBusy}
              />
            </div>
            <RepoPicker onSelect={(picked) => void handlePickRepo(picked)} selectedFullName={null} />
            {pickerBusy && <div className="ws-card-hint" style={{ marginTop: 10 }}>Connecting…</div>}
            <button
              type="button"
              className="settings-jira-toggle-link"
              style={{ marginTop: 14 }}
              onClick={() => setUseManualPat(true)}
            >
              Use a personal access token instead
            </button>
          </div>
        ) : (
          <form onSubmit={handleConnectGithub}>
            {githubError && <div className="settings-jira-error" role="alert">{githubError}</div>}
            <div className="ws-card-hint" style={{ marginBottom: 16 }}>
              Connect a repository so Bankai can scan it with AI, populate AI Triage with findings and detailed
              remediation guidance, and open a remediation branch for each one, verified by a CI pipeline before
              you review it. If a webhook can be set up, new pushes are scanned automatically and pipeline results
              come back in real time. Generate a{' '}
              <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">personal access token</a>{' '}
              with: Contents (read/write), Pull requests (read/write), Actions (read/write — to run the verification
              pipeline), Workflows (read/write — to add the pipeline file itself; this is separate from Contents),
              and Webhooks (read/write, to enable auto-rescans and pipeline results). Classic tokens: use the
              "repo" and "workflow" scopes together.
            </div>
            {!githubAccount?.connected && (
              <div className="ws-card-hint" style={{ marginBottom: 16 }}>
                Or <Link to="/settings">connect your GitHub account</Link> once to pick from a list of your
                repositories here instead of typing one in.
              </div>
            )}
            <div className="settings-jira-grid">
              <div className="settings-jira-field">
                <label htmlFor="github-repo" className="settings-field-label">Repository</label>
                <input
                  id="github-repo"
                  className="settings-jira-input"
                  placeholder="owner/repo"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  required
                />
                {githubFieldErrors.repo && <div className="settings-jira-field-error">{githubFieldErrors.repo}</div>}
              </div>
              <div className="settings-jira-field">
                <label htmlFor="github-base-branch" className="settings-field-label">Base branch (optional)</label>
                <input
                  id="github-base-branch"
                  className="settings-jira-input"
                  placeholder="main"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                />
                {githubFieldErrors.baseBranch && <div className="settings-jira-field-error">{githubFieldErrors.baseBranch}</div>}
              </div>
              <div className="settings-jira-field">
                <label htmlFor="github-token" className="settings-field-label">Personal access token</label>
                <input
                  id="github-token"
                  type="password"
                  className="settings-jira-input"
                  placeholder="Paste your GitHub token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                />
                {githubFieldErrors.token && <div className="settings-jira-field-error">{githubFieldErrors.token}</div>}
              </div>
            </div>
            <div className="settings-jira-actions">
              <button type="submit" className="ws-btn ws-btn-primary" disabled={githubLoading}>
                {githubLoading ? 'Connecting…' : 'Connect'}
              </button>
              {githubAccount?.connected && (
                <button type="button" className="settings-jira-toggle-link" onClick={() => setUseManualPat(false)}>
                  Pick from your GitHub repos instead
                </button>
              )}
            </div>
          </form>
        )}
      </section>

      <section className="ws-card settings-section">
        <div className="ws-card-eyebrow">Remediation</div>
        <h2 className="settings-h2" style={{ marginBottom: 6 }}>SLA policy</h2>
        <div className="ws-card-hint">
          Days allowed to remediate a CVIT before it&rsquo;s marked Missed SLA. &ldquo;Approaching&rdquo; fires inside the last 20% of the window.
        </div>

        {editingSla && slaDraft ? (
          <form onSubmit={handleSaveSla}>
            {slaError && <div className="settings-jira-error" role="alert">{slaError}</div>}
            <div className="settings-sla-grid">
              {SLA_TIERS.map((tier) => (
                <div key={tier.key} className="settings-jira-field">
                  <label htmlFor={`sla-${tier.key}`} className="settings-field-label">
                    <span className={`ws-badge ${tier.badgeClass}`} style={{ fontSize: 10.5, padding: '3px 10px' }}>{tier.label}</span>
                  </label>
                  <input
                    id={`sla-${tier.key}`}
                    type="number"
                    min={1}
                    max={3650}
                    className="settings-jira-input"
                    value={slaDraft[tier.key]}
                    onChange={(e) => setSlaDraft({ ...slaDraft, [tier.key]: Number(e.target.value) })}
                    required
                  />
                </div>
              ))}
            </div>
            <div className="settings-jira-actions" style={{ marginTop: 16 }}>
              <button type="submit" className="ws-btn ws-btn-primary" disabled={slaSaving}>
                {slaSaving ? 'Saving…' : 'Save thresholds'}
              </button>
              <button type="button" className="ws-btn ws-btn-secondary" onClick={cancelEditingSla} disabled={slaSaving}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="settings-sla-grid">
              {SLA_TIERS.map((tier) => (
                <div key={tier.key} className="ws-stat-tile">
                  <span className={`ws-badge ${tier.badgeClass}`} style={{ fontSize: 10.5, padding: '3px 10px' }}>{tier.label}</span>
                  <div className="settings-sla-value-row">
                    <span className="settings-sla-value">{project?.slaPolicyDays[tier.key] ?? '—'}</span>
                    <span className="settings-sla-unit">days</span>
                  </div>
                </div>
              ))}
            </div>
            <button
              className="ws-btn ws-btn-secondary"
              style={{ marginTop: 16 }}
              onClick={startEditingSla}
              disabled={!project || !canManageProject(project.myRole)}
              title={project && !canManageProject(project.myRole) ? 'Only admins can edit the SLA policy.' : undefined}
            >
              Edit thresholds
            </button>
          </>
        )}
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

      <section className="ws-card settings-section">
        <div className="settings-team-header">
          <div>
            <div className="ws-card-eyebrow">Access</div>
            <h2 className="settings-h2">Team</h2>
          </div>
          {project && canManageProject(project.myRole) && (
            <button
              className="ws-btn ws-btn-primary"
              style={{ padding: '9px 18px', fontSize: 13 }}
              onClick={() => {
                setShowInviteForm((v) => !v);
                setInviteError(null);
                setGeneratedInviteUrl(null);
              }}
            >
              Invite member
            </button>
          )}
        </div>

        {showInviteForm && (
          <form onSubmit={handleInvite} style={{ marginBottom: 20 }}>
            {inviteError && <div className="settings-jira-error" role="alert">{inviteError}</div>}
            {generatedInviteUrl ? (
              <div className="settings-jira-field">
                <label className="settings-field-label">Invite link — copy and send this yourself</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="settings-jira-input"
                    readOnly
                    value={generatedInviteUrl}
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    className="ws-btn ws-btn-secondary"
                    onClick={() => void navigator.clipboard.writeText(generatedInviteUrl)}
                  >
                    Copy
                  </button>
                </div>
              </div>
            ) : (
              <div className="settings-jira-grid">
                <div className="settings-jira-field">
                  <label htmlFor="invite-email" className="settings-field-label">Email</label>
                  <input
                    id="invite-email"
                    type="email"
                    className="settings-jira-input"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="settings-jira-field">
                  <label htmlFor="invite-role" className="settings-field-label">Role</label>
                  <select
                    id="invite-role"
                    className="settings-jira-input"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as Exclude<MemberRole, 'owner'>)}
                  >
                    <option value="admin">Admin</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </div>
              </div>
            )}
            <div className="settings-jira-actions" style={{ marginTop: 16 }}>
              {generatedInviteUrl ? (
                <button
                  type="button"
                  className="ws-btn ws-btn-secondary"
                  onClick={() => {
                    setShowInviteForm(false);
                    setGeneratedInviteUrl(null);
                  }}
                >
                  Done
                </button>
              ) : (
                <button type="submit" className="ws-btn ws-btn-primary" disabled={inviteBusy}>
                  {inviteBusy ? 'Inviting…' : 'Send invite'}
                </button>
              )}
            </div>
          </form>
        )}

        {membersError && <div className="settings-jira-error" role="alert">{membersError}</div>}

        <div className="settings-team-head">
          <span>Member</span><span>Role</span><span className="ws-col-right">Access</span>
        </div>
        {(members ?? []).map((m, i) => {
          const style = ROLE_STYLE[m.role];
          const canManage = !!project && canManageProject(project.myRole);
          const isOwner = m.role === 'owner';
          return (
            <div key={m.id} className="settings-team-row">
              <span className="settings-team-member">
                <span className="ws-avatar-chip" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                  {initialsFrom(m.name)}
                </span>
                <span className="settings-team-member-text">
                  <span className="settings-team-member-name">{m.name}</span>
                  {m.email && <span className="settings-team-member-email">{m.email}</span>}
                </span>
              </span>
              <span>
                {canManage && !isOwner ? (
                  <select
                    className="ws-select"
                    value={m.role}
                    disabled={memberActionBusy === m.id}
                    onChange={(e) => void handleRoleChange(m.id, e.target.value as Exclude<MemberRole, 'owner'>)}
                  >
                    <option value="admin">Admin</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                ) : (
                  <span
                    className="ws-badge ws-badge--outline"
                    style={{ borderColor: style.border, color: style.color, textTransform: 'capitalize' }}
                  >
                    {m.role}
                  </span>
                )}
              </span>
              <span className="ws-col-right settings-team-access" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
                {style.access}
                {canManage && !isOwner && (
                  <button
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 11.5, color: 'var(--color-red)', fontWeight: 600 }}
                    disabled={memberActionBusy === m.id}
                    onClick={() => void handleRemoveMember(m.id)}
                  >
                    Remove
                  </button>
                )}
              </span>
            </div>
          );
        })}

        {(invites ?? []).length > 0 && (
          <>
            <div className="settings-team-head" style={{ marginTop: 10 }}>
              <span>Pending invite</span><span>Role</span><span className="ws-col-right"></span>
            </div>
            {(invites ?? []).map((inv) => (
              <div key={inv.id} className="settings-team-row">
                <span className="settings-team-member">
                  <span className="settings-team-member-text">
                    <span className="settings-team-member-name">{inv.email}</span>
                    <span className="settings-team-member-email">Invited {new Date(inv.createdAt).toLocaleDateString()}</span>
                  </span>
                </span>
                <span><span className="ws-badge ws-badge--outline" style={{ textTransform: 'capitalize' }}>{inv.role}</span></span>
                <span className="ws-col-right" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
                  <button
                    className="ws-btn ws-btn-secondary"
                    style={{ padding: '4px 10px', fontSize: 11.5 }}
                    onClick={() => void navigator.clipboard.writeText(inviteLink(inv.token))}
                  >
                    Copy link
                  </button>
                  {project && canManageProject(project.myRole) && (
                    <button
                      className="ws-btn ws-btn-danger-outline"
                      style={{ padding: '4px 10px', fontSize: 11.5 }}
                      disabled={memberActionBusy === inv.id}
                      onClick={() => void handleRevokeInvite(inv.id)}
                    >
                      Revoke
                    </button>
                  )}
                </span>
              </div>
            ))}
          </>
        )}
      </section>

      {project?.myRole === 'owner' && (
        <section className="ws-card settings-section" style={{ borderColor: 'var(--color-red)' }}>
          <div className="ws-card-eyebrow" style={{ color: 'var(--color-red)' }}>Danger zone</div>
          <h2 className="settings-h2">Delete project</h2>
          <div className="ws-card-hint">
            Permanently deletes this project and everything in it — scans, findings, tickets, activity history, and
            all team members and invites. This cannot be undone.
          </div>

          {!showDeleteConfirm ? (
            <button
              className="ws-btn ws-btn-danger-outline"
              style={{ marginTop: 16 }}
              onClick={() => {
                setShowDeleteConfirm(true);
                setDeleteConfirmText('');
                setDeleteError(null);
              }}
            >
              Delete project
            </button>
          ) : (
            <form onSubmit={handleDeleteProject} style={{ marginTop: 16 }}>
              {deleteError && <div className="settings-jira-error" role="alert">{deleteError}</div>}
              <div className="settings-jira-field">
                <label htmlFor="delete-confirm" className="settings-field-label">
                  Type <strong>{project.name}</strong> to confirm
                </label>
                <input
                  id="delete-confirm"
                  className="settings-jira-input"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <div className="settings-jira-actions" style={{ marginTop: 16 }}>
                <button
                  type="submit"
                  className="ws-btn"
                  style={{ background: 'var(--color-red)', color: '#fff' }}
                  disabled={deleteBusy || deleteConfirmText !== project.name}
                >
                  {deleteBusy ? 'Deleting…' : 'Permanently delete this project'}
                </button>
                <button type="button" className="ws-btn ws-btn-secondary" onClick={() => setShowDeleteConfirm(false)} disabled={deleteBusy}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      )}
    </main>
  );
}
