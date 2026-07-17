import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import { getOverview, type Overview as OverviewData } from '../../lib/api';
import { useProject } from '../../lib/project-context';
import './Overview.css';

const SEVERITY_COLORS: Record<string, string> = { Critical: '#DC2626', High: '#F97316', Medium: '#EAB308', Low: '#8A8A8E' };

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? `Today ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`
    : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function buildTrend(trend: OverviewData['trend']) {
  if (trend.length === 0) return null;

  const maxVal = Math.max(1, ...trend.map((t) => t.totalFindings));
  const points = trend.map((t, i) => {
    const x = trend.length === 1 ? 360 : 10 + (700 * i) / (trend.length - 1);
    const y = 190 - (170 * t.totalFindings) / maxVal;
    return { x, y, date: t.date };
  });
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1]!.x.toFixed(1)},190 L${points[0]!.x.toFixed(1)},190 Z`;
  const last = points[points.length - 1]!;

  return { points, linePath, areaPath, last };
}

export default function Overview() {
  const { project } = useProject();
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    getOverview(project.id)
      .then(({ overview: fetched }) => {
        if (!cancelled) setOverview(fetched);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the project overview.');
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  if (error) {
    return (
      <main className="ws-page">
        <WorkspaceBreadcrumb current="Overview" />
        <div className="ws-divider" />
        <div className="ws-empty"><div className="ws-empty-title">{error}</div></div>
      </main>
    );
  }

  if (!overview) {
    return (
      <main className="ws-page">
        <WorkspaceBreadcrumb current="Overview" />
        <div className="ws-divider" />
        <div className="page-subtitle">Loading overview…</div>
      </main>
    );
  }

  const trend = buildTrend(overview.trend);

  return (
    <main className="ws-page">
      <WorkspaceBreadcrumb current="Overview" />
      <div className="ws-divider" />

      <div className="overview-kpi-grid">
        <div className="ws-card overview-kpi-card">
          <div className="overview-kpi-label">Total CVITs</div>
          <div className="overview-kpi-value">{overview.kpis.totalCvits}</div>
        </div>
        <div className="ws-card overview-kpi-card">
          <div className="overview-kpi-label">SLA breached</div>
          <div className="overview-kpi-value">{overview.kpis.slaBreachedPct}<span className="overview-kpi-unit">%</span></div>
        </div>
        <div className="ws-card overview-kpi-card">
          <div className="overview-kpi-label">Open tickets</div>
          <div className="overview-kpi-value">{overview.kpis.openTickets}</div>
        </div>
        <div className="ws-card overview-kpi-card">
          <div className="overview-kpi-label">Mean time to remediate</div>
          <div className="overview-kpi-value">{overview.kpis.meanTimeToRemediateDays}<span className="overview-kpi-unit">d</span></div>
        </div>
      </div>

      <div className="overview-trend-grid">
        <section className="ws-card overview-trend-card">
          <div className="ws-card-eyebrow">Scan history</div>
          <h2 className="ws-card-title">CVITs over time</h2>
          {trend ? (
            <>
              <svg viewBox="0 0 720 210" className="overview-trend-svg">
                <line x1="10" y1="10" x2="710" y2="10" stroke="var(--color-divider)" strokeWidth="1" />
                <line x1="10" y1="70" x2="710" y2="70" stroke="var(--color-divider)" strokeWidth="1" />
                <line x1="10" y1="130" x2="710" y2="130" stroke="var(--color-divider)" strokeWidth="1" />
                <line x1="10" y1="190" x2="710" y2="190" stroke="var(--color-divider)" strokeWidth="1" />
                <path d={trend.areaPath} fill="rgba(37,99,235,0.07)" />
                <path d={trend.linePath} fill="none" stroke="var(--color-blue)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx={trend.last.x} cy={trend.last.y} r="4.5" fill="var(--color-blue)" stroke="var(--color-surface)" strokeWidth="2" />
              </svg>
              <div className="overview-trend-labels">
                {trend.points.map((p) => (
                  <span key={p.date}>{new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                ))}
              </div>
            </>
          ) : (
            <div className="page-subtitle">No scans uploaded yet.</div>
          )}
        </section>

        <section className="ws-card overview-severity-card">
          <div className="ws-card-eyebrow">All services</div>
          <h2 className="ws-card-title">Severity distribution</h2>
          <div className="overview-severity-list">
            {overview.severityDistribution.map((s) => (
              <div key={s.label}>
                <div className="overview-severity-row">
                  <span className="overview-severity-name">{s.label}</span>
                  <span className="overview-severity-count">{s.count}</span>
                </div>
                <div className="ws-progress-track">
                  <div className="ws-progress-fill" style={{ width: `${s.pct}%`, background: SEVERITY_COLORS[s.label] }} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="overview-bottom-grid">
        <section className="ws-card overview-service-card">
          <div className="ws-card-eyebrow">Per service</div>
          <h2 className="ws-card-title">Service breakdown</h2>
          {overview.serviceBreakdown.length === 0 ? (
            <div className="page-subtitle">No findings yet.</div>
          ) : (
            <>
              <div className="overview-service-head">
                <span>Service</span>
                <span className="ws-col-right">Total</span>
                <span className="ws-col-right">Missed SLA</span>
                <span className="ws-col-right">Approaching</span>
                <span className="ws-col-right">On track</span>
              </div>
              {overview.serviceBreakdown.map((row) => (
                <div key={row.name} className="overview-service-row">
                  <span className="overview-service-name">{row.name}</span>
                  <span className="ws-col-right overview-service-total">{row.total}</span>
                  <span className="ws-col-right overview-service-missed">{row.missed}</span>
                  <span className="ws-col-right overview-service-approaching">{row.approaching}</span>
                  <span className="ws-col-right overview-service-ontrack">{row.onTrack}</span>
                </div>
              ))}
              <div className="overview-service-bar">
                {(() => {
                  const totals = overview.serviceBreakdown.reduce(
                    (acc, s) => ({ missed: acc.missed + s.missed, approaching: acc.approaching + s.approaching, onTrack: acc.onTrack + s.onTrack }),
                    { missed: 0, approaching: 0, onTrack: 0 },
                  );
                  const sum = Math.max(1, totals.missed + totals.approaching + totals.onTrack);
                  return (
                    <>
                      <div style={{ width: `${(totals.missed / sum) * 100}%`, background: '#EF4444' }} />
                      <div style={{ width: `${(totals.approaching / sum) * 100}%`, background: '#EAB308' }} />
                      <div style={{ width: `${(totals.onTrack / sum) * 100}%`, background: '#22C55E' }} />
                    </>
                  );
                })()}
              </div>
              <div className="overview-service-legend">
                <span><span className="overview-legend-dot" style={{ background: '#EF4444' }} />Missed SLA</span>
                <span><span className="overview-legend-dot" style={{ background: '#EAB308' }} />Approaching</span>
                <span><span className="overview-legend-dot" style={{ background: '#22C55E' }} />On track</span>
              </div>
            </>
          )}
        </section>

        <section className="ws-card overview-activity-card">
          <div className="overview-activity-header">
            <div>
              <div className="ws-card-eyebrow">Latest events</div>
              <h2 className="ws-card-title">Recent activity</h2>
            </div>
            <Link to={`/workspace/${project?.id}/activity`} className="overview-activity-view-all">View all</Link>
          </div>
          <div>
            {overview.recentActivity.length === 0 ? (
              <div className="page-subtitle">No activity yet.</div>
            ) : (
              overview.recentActivity.map((ev) => (
                <div key={ev.id} className="overview-activity-item">
                  <span className="ws-dot" style={{ background: ev.type === 'sla' ? '#EF4444' : ev.type === 'ticket' ? '#2563EB' : ev.type === 'triage' ? '#22C55E' : '#8A8A8E' }} />
                  <span className="overview-activity-text">
                    <strong>{ev.actor}</strong> {ev.summary} {ev.linkLabel && <strong>{ev.linkLabel}</strong>}
                  </span>
                  <span className="overview-activity-time">{formatEventTime(ev.createdAt)}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
