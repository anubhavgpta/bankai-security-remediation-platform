import { Link } from 'react-router-dom';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import { useProject } from '../../lib/project-context';
import './StepDetail.css';

const MAPPING = [
  { field: 'summary', from: 'defect.title', rule: 'Prefixed with service: "[Identity Apps] Upgrade OpenSSL…"' },
  { field: 'priority', from: 'defect.severity', rule: 'Critical → P1 · High → P2 · Medium → P3 · Low → P4' },
  { field: 'description', from: 'finding + evidence + rationale', rule: 'Full audit trail embedded, CVIT ids as remote links' },
  { field: 'duedate', from: 'defect.sla_due', rule: 'SLA deadline becomes the Jira due date' },
  { field: 'labels', from: 'bankai · service · severity', rule: 'Keeps Bankai-created tickets filterable on the board' },
];

const LAST_BATCH = [
  { key: 'BNK-129', title: 'Remove public read ACL from idp-export-archive', refs: 'CVIT-2259 · CR-1105' },
  { key: 'BNK-127', title: 'Add rate limiting to password reset endpoint', refs: 'CVIT-2205 · PR-2872 · CR-1103' },
];

const LINKAGE = [
  { tag: 'PR', title: 'Pull request', body: 'Attached automatically when a branch named after the ticket key (bnk-112/…) opens a PR.' },
  { tag: 'CR', title: 'Change request', body: 'The change-management record for the fix. Required before production rollout of P1/P2 tickets.' },
  { tag: 'CD', title: 'Deployment', body: "The deployment record that shipped the fix. Its timestamp is used to verify SLA compliance." },
];

export default function JiraTicketsDetail() {
  const { project } = useProject();

  return (
    <main className="ws-page ws-page--narrow">
      <WorkspaceBreadcrumb current="Jira Tickets" />
      <div className="ws-divider" />

      <section className="ws-card step-header">
        <div className="step-header-num step-header-num--pending">3</div>
        <div className="step-header-text">
          <h1 className="step-header-title">Jira Tickets</h1>
          <div className="step-header-sub">Defects to tickets with PR/CR/CD · project BNK · last synced today 07:40</div>
        </div>
        <span className="step-header-status ws-badge--pill-neutral">Pending</span>
        <Link to={`/workspace/${project?.id}/tickets`} className="step-header-next">Open board →</Link>
      </section>

      <section className="ws-card step-section">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div className="ws-card-eyebrow">This week&rsquo;s batch</div>
            <h2 className="ws-card-title" style={{ marginBottom: 0 }}>Create tickets from weekly_scan_jul06.csv</h2>
          </div>
          <span className="ws-badge ws-badge--outline ws-badge--bucket-new" style={{ fontSize: 13, padding: '6px 14px' }}>0 new Jira row(s)</span>
        </div>
        <div className="ws-dropzone" style={{ flexDirection: 'row', textAlign: 'left', padding: '26px 22px', marginTop: 16, gap: 16 }}>
          <span style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--color-fill)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6v-1A1 1 0 0 1 3.5 4h9a1 1 0 0 1 1 1v1a2 2 0 0 0 0 4v1a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-1a2 2 0 0 0 0-4Z" /></svg>
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>No eligible rows in this intake</div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', marginTop: 3 }}>
              All 376 CVITs matched prior state. Tickets are only created from <strong style={{ color: '#DB2777' }}>New Delta</strong> rows — nothing to send to Jira this week.
            </div>
          </div>
          <button disabled className="ws-btn ws-btn-disabled" style={{ cursor: 'not-allowed' }}>Create 0 tickets</button>
        </div>

        <div style={{ marginTop: 22 }}>
          <div className="ws-card-eyebrow" style={{ marginBottom: 10 }}>Last created batch — Jun 29</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {LAST_BATCH.map((b) => (
              <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--color-bg)', borderRadius: 12, padding: '12px 16px' }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--color-green)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, flexShrink: 0 }}>✓</span>
                <span className="ws-mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-blue)', width: 70 }}>{b.key}</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{b.title}</span>
                <span className="ws-mono" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{b.refs}</span>
              </div>
            ))}
          </div>
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

      <section className="ws-card">
        <div className="ws-card-eyebrow">Traceability</div>
        <h2 className="ws-card-title">PR / CR / CD linkage</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          {LINKAGE.map((l) => (
            <div key={l.tag} style={{ background: 'var(--color-bg)', borderRadius: 14, padding: 18 }}>
              <span className="ws-mono" style={{ display: 'inline-flex', fontSize: 11, fontWeight: 700, background: 'var(--color-fill)', borderRadius: 6, padding: '3px 9px' }}>{l.tag}</span>
              <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 10 }}>{l.title}</div>
              <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', marginTop: 5, lineHeight: 1.5 }}>{l.body}</div>
            </div>
          ))}
        </div>
        <div className="step-footnote">References are pulled on every sync; a ticket cannot move to Done without all three present.</div>
      </section>
    </main>
  );
}
