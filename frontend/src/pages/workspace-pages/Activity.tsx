import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import { listActivity, type ActivityEvent } from '../../lib/api';
import { useProject } from '../../lib/project-context';
import './Activity.css';

type EventType = ActivityEvent['type'];

const TABS: { key: EventType | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'upload', label: 'Uploads' },
  { key: 'triage', label: 'Triage' },
  { key: 'ticket', label: 'Tickets' },
  { key: 'sla', label: 'SLA' },
];

function eventIcon(type: EventType): { bg: string; icon: ReactElement } {
  const stroke = { fill: 'none', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (type === 'upload') return { bg: 'var(--color-fill)', icon: (
    <svg width="15" height="15" viewBox="0 0 16 16" stroke="#3A3A3C" {...stroke}><path d="M8 11V3.5" /><path d="M5 6 8 3l3 3" /><path d="M3 11.5v1A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-1" /></svg>
  ) };
  if (type === 'triage') return { bg: '#DCFCE7', icon: (
    <svg width="15" height="15" viewBox="0 0 16 16" stroke="#15803D" {...stroke}><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg>
  ) };
  if (type === 'ticket') return { bg: '#DBEAFE', icon: (
    <svg width="15" height="15" viewBox="0 0 16 16" stroke="#1D4ED8" {...stroke}><path d="M2.5 6v-1A1 1 0 0 1 3.5 4h9a1 1 0 0 1 1 1v1a2 2 0 0 0 0 4v1a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-1a2 2 0 0 0 0-4Z" /></svg>
  ) };
  return { bg: '#FEE2E2', icon: (
    <svg width="15" height="15" viewBox="0 0 16 16" stroke="#B91C1C" {...stroke}><path d="M8 5v4" /><circle cx="8" cy="11.5" r="0.4" fill="#B91C1C" /><path d="M7.1 2.3 1.8 12a1 1 0 0 0 .9 1.5h10.6a1 1 0 0 0 .9-1.5L8.9 2.3a1 1 0 0 0-1.8 0Z" /></svg>
  ) };
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const weekdayMonthDay = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  if (sameDay(date, today)) return `Today — ${weekdayMonthDay}`;
  if (sameDay(date, yesterday)) return `Yesterday — ${weekdayMonthDay}`;
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function Activity() {
  const { project } = useProject();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fType, setFType] = useState<EventType | 'all'>('all');
  const [fActor, setFActor] = useState('all');

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    listActivity(project.id)
      .then(({ activity }) => {
        if (!cancelled) setEvents(activity);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load activity.');
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const actors = useMemo(() => Array.from(new Set((events ?? []).map((e) => e.actor))).sort(), [events]);

  const filtered = useMemo(
    () => (events ?? []).filter((ev) => (fType === 'all' || ev.type === fType) && (fActor === 'all' || ev.actor === fActor)),
    [events, fType, fActor],
  );

  const groups = useMemo(() => {
    const order: string[] = [];
    const byDay: Record<string, ActivityEvent[]> = {};
    filtered.forEach((ev) => {
      const label = dayLabel(ev.createdAt);
      if (!byDay[label]) {
        byDay[label] = [];
        order.push(label);
      }
      byDay[label]!.push(ev);
    });
    return order.map((day) => ({ day, items: byDay[day]! }));
  }, [filtered]);

  if (error) {
    return (
      <main className="ws-page ws-page--narrow">
        <WorkspaceBreadcrumb current="Activity" />
        <div className="ws-divider" />
        <div className="ws-empty"><div className="ws-empty-title">{error}</div></div>
      </main>
    );
  }

  return (
    <main className="ws-page ws-page--narrow">
      <WorkspaceBreadcrumb current="Activity" />
      <div className="ws-divider" />

      <div className="ws-header-row">
        <div>
          <div className="ws-header-eyebrow">Audit log</div>
          <h2 className="ws-header-title">Activity</h2>
        </div>
        <div className="activity-filters">
          <div className="ws-segmented">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                className={`ws-segmented-btn ${fType === tab.key ? 'ws-segmented-btn--active' : ''}`}
                onClick={() => setFType(tab.key)}
                style={{ padding: '6px 13px', fontSize: 12 }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <select className="ws-select" value={fActor} onChange={(e) => setFActor(e.target.value)}>
            <option value="all">All actors</option>
            {actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      {!events ? (
        <div className="page-subtitle">Loading activity…</div>
      ) : groups.length === 0 ? (
        <div className="ws-empty">
          <div className="ws-empty-icon">
            <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 10h3.2l2.1-5 3.9 10 2.1-5h3.7" /></svg>
          </div>
          <div className="ws-empty-title">No activity yet</div>
          <div className="ws-empty-body">Every upload, triage run, and ticket will be recorded here as an auditable trail.</div>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.day} className="activity-group">
              <div className="activity-group-day">{g.day}</div>
              <section className="activity-group-card">
                {g.items.map((ev) => {
                  const ic = eventIcon(ev.type);
                  return (
                    <div key={ev.id} className="activity-row">
                      <span className="activity-row-icon" style={{ background: ic.bg }}>{ic.icon}</span>
                      <div className="activity-row-body">
                        <div className="activity-row-text">
                          <strong>{ev.actor}</strong> {ev.summary}{' '}
                          {ev.linkLabel && ev.linkTo && (
                            <Link to={`/workspace/${project?.id}/${ev.linkTo}`} className="activity-row-link">{ev.linkLabel}</Link>
                          )}
                        </div>
                        {ev.meta && <div className="activity-row-meta">{ev.meta}</div>}
                      </div>
                      <span className="activity-row-time">{timeLabel(ev.createdAt)}</span>
                    </div>
                  );
                })}
              </section>
            </div>
          ))}
          <div className="activity-count-footer">{filtered.length} events shown</div>
        </>
      )}
    </main>
  );
}
