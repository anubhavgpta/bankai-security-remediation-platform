import { Link } from 'react-router-dom';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import { useProject } from '../../lib/project-context';
import './StepDetail.css';

const MAPPING = [
  { from: 'plugin_id + host + port', to: 'cvit_id', rule: 'Stable fingerprint; keys the week-over-week diff' },
  { from: 'plugin_name', to: 'finding_title', rule: 'Normalized casing, CVE ids preserved' },
  { from: 'cvss3_score', to: 'severity_band', rule: 'Banded: ≥9 Critical · ≥7 High · ≥4 Medium · else Low' },
  { from: 'first_found', to: 'first_seen · sla_due', rule: 'SLA clock starts at first detection, per severity policy' },
  { from: 'service_tag', to: 'service', rule: "Drives the per-service sheet split below" },
];

const SPLITS = [
  { sheet: 'sheet · identity_core', rows: 152, label: 'Identity Core' },
  { sheet: 'sheet · identity_apps', rows: 224, label: 'Identity Apps' },
  { sheet: 'unmapped', rows: 0, label: 'No unknown service tags' },
];

const RULES = [
  { n: 1, text: 'Fingerprint has no match in prior state — first time this finding is seen.', badgeClass: 'ws-badge--bucket-new', label: 'New Delta' },
  { n: 2, text: 'Fingerprint matches and no tracked field changed — SLA clock and ticket carry over.', badgeClass: 'ws-badge--bucket-progress', label: 'Already in Progress' },
  { n: 3, text: 'Fingerprint matches but severity, score or exposure drifted — linked ticket is updated, not duplicated.', badgeClass: 'ws-badge--bucket-changed', label: 'Changed' },
  { n: 4, text: 'Present in prior state but absent from this scan — verified against version banners before closing.', badgeClass: 'ws-badge--bucket-resolved', label: 'Resolved / Not Present' },
];

export default function IntakeDetail() {
  const { project } = useProject();

  return (
    <main className="ws-page ws-page--narrow">
      <WorkspaceBreadcrumb current="Intake & Triage" />
      <div className="ws-divider" />

      <section className="ws-card step-header">
        <div className="step-header-num step-header-num--done">1</div>
        <div className="step-header-text">
          <h1 className="step-header-title">Intake &amp; Triage</h1>
          <div className="step-header-sub">CSV to XLS, split by service · last run Mon, Jul 6 · 09:05 on weekly_scan_jul06.csv</div>
        </div>
        <span className="step-header-status ws-badge--pill-green">✓ Complete</span>
        <Link to={`/workspace/${project?.id}/workflow/defect-generation`} className="step-header-next">Next: Defect Generation →</Link>
      </section>

      <section className="ws-card step-section">
        <div className="ws-card-eyebrow">Transform</div>
        <h2 className="ws-card-title">CSV → XLS column mapping</h2>
        <div className="step-mapping-head">
          <span>Scanner CSV column</span><span></span><span>XLS field</span><span>Rule</span>
        </div>
        {MAPPING.map((m) => (
          <div key={m.from} className="step-mapping-row">
            <span className="step-mapping-field ws-mono">{m.from}</span>
            <span className="step-mapping-arrow">→</span>
            <span className="step-mapping-field step-mapping-field--strong ws-mono">{m.to}</span>
            <span className="step-mapping-rule">{m.rule}</span>
          </div>
        ))}
      </section>

      <section className="ws-card step-section">
        <div className="ws-card-eyebrow">Output</div>
        <h2 className="ws-card-title">Service split preview</h2>
        <div className="step-tiles">
          {SPLITS.map((s) => (
            <div key={s.sheet} className="step-tile">
              <div className="ws-mono" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{s.sheet}</div>
              <div className="step-tile-value" style={{ marginTop: 8 }}>{s.rows} <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)' }}>rows</span></div>
              <div className="step-tile-label">{s.label}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 16 }}>
          <a href="#" onClick={(e) => e.preventDefault()} style={{ fontSize: 13, fontWeight: 600 }}>Download identity_snapshot_jul06.xlsx</a>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>generated Mon 09:05 · 84 KB</span>
        </div>
      </section>

      <section className="ws-card">
        <div className="ws-card-eyebrow">Diff against prior state</div>
        <h2 className="ws-card-title">Triage rules</h2>
        <div className="step-rule-list">
          {RULES.map((r) => (
            <div key={r.n} className="step-rule-row">
              <span className="step-rule-num">{r.n}</span>
              <span className="step-rule-text">{r.text}</span>
              <span className={`ws-badge ws-badge--outline ${r.badgeClass}`}>{r.label}</span>
            </div>
          ))}
        </div>
        <div className="step-footnote">Only <strong style={{ color: '#DB2777' }}>New Delta</strong> rows are eligible for Jira ticket creation in step 3.</div>
      </section>
    </main>
  );
}
