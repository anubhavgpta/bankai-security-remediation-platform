import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import { listFindings, listTickets, type Finding, type Ticket } from '../../lib/api';
import { useProject } from '../../lib/project-context';
import './StepDetail.css';

const MAPPING = [
  { field: 'summary', from: 'service + finding.title', rule: 'Prefixed with service: "[Identity Apps] Upgrade OpenSSL…"' },
  { field: 'priority', from: 'finding.severity', rule: 'Critical → Highest · High → High · Medium → Medium · Low → Low' },
  { field: 'description', from: 'id, title, severity, cvss_score, cwe, component, file_path, type, status, date_found, fix_available, source_url, description', rule: 'Full finding detail, rendered as Atlassian Document Format' },
  { field: 'duedate', from: 'finding.sla_due_date', rule: 'SLA deadline becomes the Jira due date' },
];

export default function JiraTicketsDetail() {
  const { project } = useProject();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    Promise.all([listTickets(project.id), listFindings(project.id)]).then(([t, f]) => {
      if (cancelled) return;
      setTickets(t.tickets);
      setFindings(f.findings);
    });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const eligible = (findings ?? []).filter((f) => f.bucket === 'New Delta' && !f.ticketKey);
  const lastBatch = (tickets ?? [])
    .filter((t) => t.jiraIssueKey)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);
  const syncErrors = (tickets ?? []).filter((t) => t.jiraSyncError);
  const branchErrors = (tickets ?? []).filter((t) => t.githubBranchError);

  return (
    <main className="ws-page ws-page--narrow">
      <WorkspaceBreadcrumb current="Jira Tickets" />
      <div className="ws-divider" />

      <section className="ws-card step-header">
        <div className={`step-header-num ${project?.jiraConnected ? 'step-header-num--done' : 'step-header-num--pending'}`}>3</div>
        <div className="step-header-text">
          <h1 className="step-header-title">Jira Tickets</h1>
          <div className="step-header-sub">
            {project?.jiraConnected ? `Defects to tickets · project ${project.jiraKey}` : 'Jira sync not connected'}
          </div>
        </div>
        <span className={`step-header-status ${project?.jiraConnected ? 'ws-badge--pill-green' : 'ws-badge--pill-neutral'}`}>
          {project?.jiraConnected ? 'Connected' : 'Pending'}
        </span>
        <Link to={`/workspace/${project?.id}/tickets`} className="step-header-next">Open board →</Link>
      </section>

      <section className="ws-card step-section">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div className="ws-card-eyebrow">Eligible for Jira</div>
            <h2 className="ws-card-title" style={{ marginBottom: 0 }}>New delta findings not yet ticketed</h2>
          </div>
          <span className="ws-badge ws-badge--outline ws-badge--bucket-new" style={{ fontSize: 13, padding: '6px 14px' }}>
            {eligible.length} new Jira row(s)
          </span>
        </div>
        <div className="ws-dropzone" style={{ flexDirection: 'row', textAlign: 'left', padding: '26px 22px', marginTop: 16, gap: 16 }}>
          <span style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--color-fill)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6v-1A1 1 0 0 1 3.5 4h9a1 1 0 0 1 1 1v1a2 2 0 0 0 0 4v1a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-1a2 2 0 0 0 0-4Z" /></svg>
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              {eligible.length === 0 ? 'No eligible rows right now' : `${eligible.length} row(s) ready to send to Jira`}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', marginTop: 3 }}>
              Tickets are only created from <strong style={{ color: '#DB2777' }}>New Delta</strong> rows — mark them for Jira from{' '}
              <Link to={`/workspace/${project?.id}/triage`}>AI Triage</Link>.
            </div>
          </div>
        </div>

        <div style={{ marginTop: 22 }}>
          <div className="ws-card-eyebrow" style={{ marginBottom: 10 }}>Tickets synced to Jira</div>
          {!tickets ? (
            <div className="page-subtitle">Loading…</div>
          ) : lastBatch.length === 0 ? (
            <div className="page-subtitle">
              {project?.jiraConnected ? 'No tickets have synced to Jira yet.' : 'Connect Jira in Settings to start syncing tickets.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {lastBatch.map((t) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--color-bg)', borderRadius: 12, padding: '12px 16px' }}>
                  <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--color-green)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, flexShrink: 0 }}>✓</span>
                  <a href={t.jiraIssueUrl ?? undefined} target="_blank" rel="noreferrer" className="ws-mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-blue)', width: 90 }}>
                    {t.jiraIssueKey}
                  </a>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{t.title}</span>
                  {t.githubBranchUrl && (
                    <a
                      href={t.githubBranchUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ws-mono"
                      style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                      title={`Open branch ${t.githubBranchName}`}
                    >
                      {t.githubBranchName}
                    </a>
                  )}
                  <span className="ws-mono" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{t.key}</span>
                </div>
              ))}
            </div>
          )}
          {syncErrors.length > 0 && (
            <div className="step-footnote" style={{ color: '#B91C1C' }}>
              {syncErrors.length} ticket(s) could not sync to Jira — see the Tickets board for details.
            </div>
          )}
          {branchErrors.length > 0 && (
            <div className="step-footnote" style={{ color: '#B91C1C' }}>
              {branchErrors.length} ticket(s) could not get a remediation branch — see the Tickets board for details.
            </div>
          )}
        </div>
      </section>

      <section className="ws-card step-section">
        <div className="ws-card-eyebrow">Transform</div>
        <h2 className="ws-card-title">Defect → ticket mapping</h2>
        <div className="step-mapping-head">
          <span>Jira field</span><span></span><span>Defect source</span><span>Rule</span>
        </div>
        {MAPPING.map((m) => (
          <div key={m.field} className="step-mapping-row">
            <span className="step-mapping-field step-mapping-field--strong ws-mono">{m.field}</span>
            <span className="step-mapping-arrow">←</span>
            <span className="step-mapping-field ws-mono">{m.from}</span>
            <span className="step-mapping-rule">{m.rule}</span>
          </div>
        ))}
      </section>
    </main>
  );
}
