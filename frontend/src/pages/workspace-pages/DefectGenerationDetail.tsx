import { Link } from 'react-router-dom';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import { useProject } from '../../lib/project-context';
import './StepDetail.css';

type Severity = 'Critical' | 'High' | 'Medium' | 'Low';

const DEFECTS: { id: string; title: string; service: string; severity: Severity; cvits: number; state: string; stateColor: string }[] = [
  { id: 'DEF-201', title: 'Upgrade OpenSSL across idp-apps fleet', service: 'Identity Apps', severity: 'Critical', cvits: 12, state: 'Ticketed · BNK-112', stateColor: '#1D4ED8' },
  { id: 'DEF-118', title: 'Enforce SAML response signature on ACS endpoint', service: 'Identity Core', severity: 'Critical', cvits: 1, state: 'Ticketed · BNK-118', stateColor: '#1D4ED8' },
  { id: 'DEF-224', title: 'Rotate expiring intermediate TLS certificate', service: 'Identity Core', severity: 'High', cvits: 3, state: 'Updated Jul 6', stateColor: '#A16207' },
  { id: 'DEF-229', title: 'Remove public read ACL from idp-export-archive', service: 'Identity Apps', severity: 'High', cvits: 1, state: 'Ticketed · BNK-129', stateColor: '#1D4ED8' },
  { id: 'DEF-217', title: 'Add rate limiting to password reset endpoint', service: 'Identity Core', severity: 'Medium', cvits: 2, state: 'Ticketed · BNK-127', stateColor: '#1D4ED8' },
  { id: 'DEF-233', title: 'Rebuild shared base image against upstream tag', service: 'Identity Apps', severity: 'Low', cvits: 14, state: 'Resolved', stateColor: '#15803D' },
];

const MAPPING = [
  { field: 'title', from: 'finding_title', rule: 'Rewritten as an action for the cluster ("Upgrade…", "Remove…")' },
  { field: 'severity', from: 'max(severity_band)', rule: 'Highest severity across clustered CVITs wins' },
  { field: 'cvit_refs', from: 'cvit_id list', rule: 'Every clustered row stays traceable from the defect' },
  { field: 'sla_due', from: 'min(first_seen) + policy', rule: 'Oldest finding in the cluster sets the deadline' },
];

function sevBadgeClass(sev: Severity) {
  return `ws-badge ws-badge--${sev.toLowerCase()}`;
}

export default function DefectGenerationDetail() {
  const { project } = useProject();

  return (
    <main className="ws-page ws-page--narrow">
      <WorkspaceBreadcrumb current="Defect Generation" />
      <div className="ws-divider" />

      <section className="ws-card step-header">
        <div className="step-header-num step-header-num--done">2</div>
        <div className="step-header-text">
          <h1 className="step-header-title">Defect Generation</h1>
          <div className="step-header-sub">XLS to structured defects per service · last run Mon, Jul 6 · 09:06</div>
        </div>
        <span className="step-header-status ws-badge--pill-green">✓ Complete</span>
        <Link to={`/workspace/${project?.id}/workflow/jira-tickets`} className="step-header-next">Next: Jira Tickets →</Link>
      </section>

      <section className="ws-card step-section">
        <div className="ws-card-eyebrow">Transform</div>
        <h2 className="ws-card-title" style={{ marginBottom: 6 }}>XLS → structured defects</h2>
        <div className="ws-card-hint">
          Rows sharing a root cause (same package, endpoint or misconfiguration) are clustered into one defect so engineering gets a fixable unit of work, not 376 lines.
        </div>
        <div className="step-tiles">
          <div className="step-tile"><div className="step-tile-value">376</div><div className="step-tile-label">XLS rows in</div></div>
          <span className="step-tile-arrow">→</span>
          <div className="step-tile"><div className="step-tile-value">41</div><div className="step-tile-label">Defects out</div></div>
          <span className="step-tile-arrow">→</span>
          <div className="step-tile"><div className="step-tile-value">2</div><div className="step-tile-label">Service backlogs</div></div>
        </div>
      </section>

      <section className="ws-card step-section">
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div className="ws-card-eyebrow">Per service</div>
            <h2 className="ws-card-title">Generated defects</h2>
          </div>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)', paddingBottom: 14 }}>showing 6 of 41</span>
        </div>
        <div className="ws-table-head" style={{ ['--ws-cols' as string]: '90px 2.4fr 1.1fr 0.9fr 0.9fr 1.1fr', padding: '0 2px 10px 2px', background: 'transparent' }}>
          <span>ID</span><span>Defect</span><span>Service</span><span>Severity</span><span className="ws-col-right">CVITs</span><span>State</span>
        </div>
        {DEFECTS.map((d) => (
          <div key={d.id} className="ws-table-row" style={{ ['--ws-cols' as string]: '90px 2.4fr 1.1fr 0.9fr 0.9fr 1.1fr', padding: '12px 2px' }}>
            <span className="ws-mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-muted)' }}>{d.id}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{d.title}</span>
            <span style={{ fontSize: 12.5, color: 'var(--color-text-subtle)' }}>{d.service}</span>
            <span><span className={sevBadgeClass(d.severity)}>{d.severity}</span></span>
            <span className="ws-col-right" style={{ fontSize: 13, fontWeight: 600 }}>{d.cvits}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: d.stateColor }}>{d.state}</span>
          </div>
        ))}
      </section>

      <section className="ws-card">
        <div className="ws-card-eyebrow">Schema</div>
        <h2 className="ws-card-title">Defect field mapping</h2>
        <div className="step-mapping-head">
          <span>Defect field</span><span></span><span>XLS source</span><span>Rule</span>
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
