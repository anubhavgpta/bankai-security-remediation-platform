import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getOverview, listScans, type Overview, type Scan } from '../../lib/api';
import { useProject } from '../../lib/project-context';
import './RemediationWorkflow.css';

const CIRCUMFERENCE = 2 * Math.PI * 60;

function buildDonutSegments(missed: number, approaching: number, onTrack: number) {
  const total = Math.max(1, missed + approaching + onTrack);
  const missedLen = (missed / total) * CIRCUMFERENCE;
  const approachingLen = (approaching / total) * CIRCUMFERENCE;
  const onTrackLen = (onTrack / total) * CIRCUMFERENCE;
  return [
    { color: '#EF4444', dasharray: `${missedLen} ${CIRCUMFERENCE}`, dashoffset: '0' },
    { color: '#EAB308', dasharray: `${approachingLen} ${CIRCUMFERENCE}`, dashoffset: `${-missedLen}` },
    { color: '#22C55E', dasharray: `${onTrackLen} ${CIRCUMFERENCE}`, dashoffset: `${-(missedLen + approachingLen)}` },
  ];
}

export default function RemediationWorkflow() {
  const { project } = useProject();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [latestScan, setLatestScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    Promise.all([getOverview(project.id), listScans(project.id)])
      .then(([{ overview: fetchedOverview }, { scans }]) => {
        if (cancelled) return;
        setOverview(fetchedOverview);
        setLatestScan(scans[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this project.');
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  if (error) {
    return (
      <main className="ws-page">
        <div className="ws-breadcrumb">
          <Link to="/projects" className="ws-breadcrumb-link">Bankai</Link>
          <span className="ws-breadcrumb-sep">›</span>
          <span className="ws-breadcrumb-current">{project?.name ?? '…'}</span>
        </div>
        <div className="ws-divider" />
        <div className="ws-empty"><div className="ws-empty-title">{error}</div></div>
      </main>
    );
  }

  const hasFindings = (overview?.kpis.totalCvits ?? 0) > 0;
  const hasTickets = (overview?.kpis.openTickets ?? 0) > 0;

  const steps = [
    { n: 1, to: 'workflow/intake-triage', title: 'Intake & Triage', sub: 'CSV to XLS, split by service', done: hasFindings },
    // No separate "defect" grouping stage is modeled — tickets are created
    // directly from accepted findings, so this reuses the intake signal.
    { n: 2, to: 'workflow/defect-generation', title: 'Defect Generation', sub: 'Findings clustered per service', done: hasFindings },
    { n: 3, to: 'workflow/jira-tickets', title: 'Jira Tickets', sub: 'Defects to tickets (Jira sync not connected)', done: hasTickets },
  ];

  return (
    <main className="ws-page">
      <div className="ws-breadcrumb">
        <Link to="/projects" className="ws-breadcrumb-link">Bankai</Link>
        <span className="ws-breadcrumb-sep">›</span>
        <span className="ws-breadcrumb-current">{project?.name ?? '…'}</span>
      </div>
      <div className="ws-divider" />

      <div className="workflow-stepper">
        {steps.map((step) => (
          <Link key={step.n} to={`/workspace/${project?.id}/${step.to}`} className="workflow-step-card">
            <div className={`workflow-step-num ${step.done ? 'workflow-step-num--done' : 'workflow-step-num--pending'}`}>
              {step.n}
            </div>
            <div className="workflow-step-text">
              <div className="workflow-step-title">{step.title}</div>
              <div className="workflow-step-sub">{step.sub}</div>
            </div>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="workflow-step-chevron">
              <path d="M6 3.5 10.5 8 6 12.5" />
            </svg>
          </Link>
        ))}
      </div>

      <section className="ws-card workflow-section">
        <div className="workflow-section-header">
          <div>
            <div className="ws-card-eyebrow">Findings Summary</div>
            <h2 className="workflow-section-title">CVIT Snapshot</h2>
          </div>
          <span className="workflow-total-badge">
            Total CVITs <span className="workflow-total-badge-value">{overview?.kpis.totalCvits ?? 0}</span>
          </span>
        </div>

        {!overview || overview.serviceBreakdown.length === 0 ? (
          <div className="page-subtitle">No findings yet — upload a scan to get started.</div>
        ) : (
          <div className="workflow-donut-grid">
            {overview.serviceBreakdown.map((d, i) => {
              const segments = buildDonutSegments(d.missed, d.approaching, d.onTrack);
              return (
                <Fragment key={d.name}>
                  {i > 0 && i % 2 === 1 && <div className="workflow-donut-divider" />}
                  <div>
                    <div className="workflow-donut-header">
                      <div className="workflow-donut-name">{d.name}</div>
                    </div>
                    <div className="workflow-donut-row">
                      <div className="workflow-donut-chart">
                        <svg width="172" height="172" viewBox="0 0 172 172" style={{ transform: 'rotate(-90deg)' }}>
                          {segments.map((s, si) => (
                            <circle key={si} cx="86" cy="86" r="60" fill="none" stroke={s.color} strokeWidth="26" strokeDasharray={s.dasharray} strokeDashoffset={s.dashoffset} />
                          ))}
                        </svg>
                        <div className="workflow-donut-center">
                          <div className="workflow-donut-center-value">{d.total}</div>
                          <div className="workflow-donut-center-label">CVITs</div>
                        </div>
                      </div>
                      <div className="workflow-donut-legend">
                        <div className="workflow-donut-legend-row">
                          <span className="ws-dot" style={{ background: '#EF4444' }} />
                          <span className="workflow-donut-legend-label">Missed SLA</span>
                          <span className="workflow-donut-legend-value">{d.missed}</span>
                        </div>
                        <div className="workflow-donut-legend-row">
                          <span className="ws-dot" style={{ background: '#EAB308' }} />
                          <span className="workflow-donut-legend-label">Approaching Target</span>
                          <span className="workflow-donut-legend-value">{d.approaching}</span>
                        </div>
                        <div className="workflow-donut-legend-row">
                          <span className="ws-dot" style={{ background: '#22C55E' }} />
                          <span className="workflow-donut-legend-label">Total CVITs</span>
                          <span className="workflow-donut-legend-value">{d.total}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
      </section>

      {latestScan && (
        <section className="ws-card workflow-section">
          <div className="workflow-section-header">
            <div>
              <div className="ws-card-eyebrow">Latest Scan</div>
              <h2 className="workflow-section-title">Triage Snapshot — {latestScan.filename}</h2>
              <div className="workflow-section-sub">Rows from this intake are eligible for Jira ticket creation once accepted.</div>
            </div>
            <span className="workflow-pink-badge">{latestScan.newDeltaCount} new delta row(s)</span>
          </div>
          <div className="workflow-snapshot-grid">
            {[
              { value: latestScan.newDeltaCount, label: 'New Delta' },
              { value: latestScan.inProgressCount, label: 'Already in Progress' },
              { value: latestScan.changedCount, label: 'Changed' },
              { value: latestScan.resolvedCount, label: 'Resolved/Not Present' },
            ].map((s) => (
              <div key={s.label} className="ws-stat-tile">
                <div className="ws-stat-tile-value" style={{ fontSize: 30 }}>{s.value}</div>
                <div className="ws-stat-tile-label" style={{ marginTop: 9 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="ws-card">
        <h2 className="workflow-intake-title">Report Intake &amp; Triage</h2>
        <div className="workflow-intake-sub">
          Upload your vulnerability scan CSV. Bankai parses it, diffs it against this project&apos;s existing findings, and splits results by service.
        </div>
        <div className="ws-dropzone">
          <svg width="64" height="52" viewBox="0 0 64 52" fill="none" stroke="var(--color-text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 40h-4.5C8 40 3.5 35.5 3.5 30c0-5 3.7-9.1 8.5-9.9C13.3 12.6 19.9 6.5 28 6.5c7 0 13 4.5 15.2 10.8 6.6 0.3 11.8 5.7 11.8 12.3 0 5.8-4.1 9.7-9.5 10.4" />
            <circle cx="32" cy="38" r="10.5" fill="var(--color-bg)" />
            <path d="M27.5 38.5 30.8 41.8 36.8 34.8" />
          </svg>
          <div className="ws-dropzone-title">Drag and drop your files here or choose files</div>
          <div className="ws-dropzone-body">
            Upload your vulnerability scan CSV. Bankai parses it, diffs it against this project&apos;s existing findings, and splits results by service.
          </div>
          <Link to={`/workspace/${project?.id}/intake`} className="ws-btn ws-btn-primary" style={{ marginTop: 20 }}>Browse File</Link>
        </div>
      </section>
    </main>
  );
}
