import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import { listTickets, type Severity, type Ticket, type TicketStatus } from '../../lib/api';
import { useProject } from '../../lib/project-context';
import './Tickets.css';

const COLUMNS: { name: TicketStatus; dot: string }[] = [
  { name: 'To Do', dot: '#8A8A8E' },
  { name: 'In Progress', dot: '#2563EB' },
  { name: 'In Review', dot: '#EAB308' },
  { name: 'Done', dot: '#22C55E' },
];

function sevBadgeClass(sev: Severity) {
  return `ws-badge ws-badge--${sev.toLowerCase()}`;
}

function statusColor(status: TicketStatus) {
  if (status === 'To Do') return { dot: '#8A8A8E', color: '#3A3A3C' };
  if (status === 'In Progress') return { dot: '#2563EB', color: '#1D4ED8' };
  if (status === 'In Review') return { dot: '#EAB308', color: '#A16207' };
  return { dot: '#22C55E', color: '#15803D' };
}

function formatDue(dueDate: string | null): string {
  if (!dueDate) return 'No due date';
  return new Date(`${dueDate}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function Tickets() {
  const { project } = useProject();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fService, setFService] = useState('all');
  const [fSeverity, setFSeverity] = useState('all');
  const [view, setView] = useState<'kanban' | 'table'>('kanban');

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    listTickets(project.id)
      .then(({ tickets: fetched }) => {
        if (!cancelled) setTickets(fetched);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load tickets. Please try again.');
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const services = useMemo(() => Array.from(new Set((tickets ?? []).map((t) => t.service))).sort(), [tickets]);

  const filtered = useMemo(
    () => (tickets ?? []).filter((t) => (fService === 'all' || t.service === fService) && (fSeverity === 'all' || t.severity === fSeverity)),
    [tickets, fService, fSeverity],
  );

  const columns = COLUMNS.map((c) => ({ ...c, cards: filtered.filter((t) => t.status === c.name) }));

  if (error) {
    return (
      <main className="ws-page">
        <WorkspaceBreadcrumb current="Tickets" />
        <div className="ws-divider" />
        <div className="ws-empty">
          <div className="ws-empty-title">{error}</div>
        </div>
      </main>
    );
  }

  return (
    <main className="ws-page">
      <WorkspaceBreadcrumb current="Tickets" />
      <div className="ws-divider" />

      <div className="tickets-title-row">
        <div className="ws-header-eyebrow">Bankai-internal tickets · Jira sync not connected</div>
        <h2 className="ws-header-title">Tickets</h2>
      </div>

      <div className="tickets-toolbar">
        <div className="tickets-toolbar-left">
          <select className="ws-select" value={fService} onChange={(e) => setFService(e.target.value)}>
            <option value="all">All services</option>
            {services.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="ws-select" value={fSeverity} onChange={(e) => setFSeverity(e.target.value)}>
            <option value="all">All severities</option>
            <option value="Critical">Critical</option>
            <option value="High">High</option>
            <option value="Medium">Medium</option>
            <option value="Low">Low</option>
          </select>
          <div className="ws-segmented">
            <button className={`ws-segmented-btn ${view === 'kanban' ? 'ws-segmented-btn--active' : ''}`} onClick={() => setView('kanban')}>Kanban</button>
            <button className={`ws-segmented-btn ${view === 'table' ? 'ws-segmented-btn--active' : ''}`} onClick={() => setView('table')}>Table</button>
          </div>
        </div>
        <div className="tickets-toolbar-right">
          <button className="ws-btn ws-btn-disabled" disabled title="Jira isn't connected yet — tickets stay in Bankai for now." style={{ padding: '9px 18px', fontSize: 13, cursor: 'not-allowed' }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 1.5v3h-3" /></svg>
            Sync with Jira
          </button>
        </div>
      </div>

      {!tickets ? (
        <div className="page-subtitle">Loading tickets…</div>
      ) : tickets.length === 0 ? (
        <div className="ws-empty">
          <div className="ws-empty-title">No tickets yet</div>
          <div className="ws-empty-body">Accept findings in AI Triage and mark them for Jira to create tickets here.</div>
        </div>
      ) : (
        <>
          {view === 'kanban' && (
            <div className="tickets-kanban">
              {columns.map((col) => (
                <div key={col.name} className="tickets-kanban-col">
                  <div className="tickets-kanban-col-header">
                    <span className="ws-dot" style={{ background: col.dot }} />
                    <span className="tickets-kanban-col-name">{col.name}</span>
                    <span className="tickets-kanban-col-count">{col.cards.length}</span>
                  </div>
                  <div className="tickets-kanban-cards">
                    {col.cards.map((t) => (
                      <div key={t.id} className="tickets-kanban-card">
                        <div className="tickets-kanban-card-top">
                          <span className="ws-mono tickets-kanban-card-key">{t.key}</span>
                          <span className={sevBadgeClass(t.severity)} style={{ padding: '2.5px 9px', fontSize: 10.5 }}>{t.severity}</span>
                        </div>
                        <div className="tickets-kanban-card-title">{t.title}</div>
                        <div className="tickets-kanban-card-meta">
                          {t.service}
                          {t.findingExternalId && (
                            <> · <Link to={`/workspace/${project?.id}/triage`} className="tickets-kanban-card-cvit">{t.findingExternalId}</Link></>
                          )}
                        </div>
                        <div className="tickets-kanban-card-footer">
                          <span className="tickets-kanban-card-due" style={{ color: t.overdue ? '#DC2626' : 'var(--color-text-muted)' }}>
                            {t.overdue ? 'Overdue · ' : 'Due '}{formatDue(t.dueDate)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {view === 'table' && (
            <section className="ws-table">
              <div className="ws-table-head tickets-grid">
                <span>Key</span><span>Title</span><span>Service</span><span>Severity</span><span>CVIT</span><span>Status</span><span className="ws-col-right">SLA due</span>
              </div>
              {filtered.map((t) => {
                const sc = statusColor(t.status);
                return (
                  <div key={t.id} className="ws-table-row tickets-grid">
                    <span className="ws-mono tickets-table-key">{t.key}</span>
                    <span className="tickets-table-title">{t.title}</span>
                    <span className="tickets-table-service">{t.service}</span>
                    <span><span className={sevBadgeClass(t.severity)}>{t.severity}</span></span>
                    <span className="ws-mono tickets-table-cvit">{t.findingExternalId ?? '—'}</span>
                    <span className="ws-dot-status" style={{ color: sc.color }}><span className="ws-dot" style={{ background: sc.dot }} />{t.status}</span>
                    <span className="ws-col-right tickets-table-due" style={{ color: t.overdue ? '#DC2626' : 'var(--color-text-muted)' }}>
                      {t.overdue ? 'Overdue · ' : 'Due '}{formatDue(t.dueDate)}
                    </span>
                  </div>
                );
              })}
            </section>
          )}
        </>
      )}
    </main>
  );
}
