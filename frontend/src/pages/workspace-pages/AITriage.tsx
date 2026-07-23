import { useEffect, useMemo, useState } from 'react';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import {
  ApiError,
  createTickets,
  listFindings,
  reassignFindingBucket,
  reassignFindingService,
  reopenTicket,
  type Bucket,
  type Finding,
  type Severity,
} from '../../lib/api';
import { canEdit } from '../../lib/roles';
import { useProject } from '../../lib/project-context';
import './AITriage.css';

const BUCKETS: Bucket[] = ['New Delta', 'In Progress', 'Changed', 'Resolved'];

function sevBadgeClass(sev: Severity) {
  return `ws-badge ws-badge--${sev.toLowerCase()}`;
}

function slaColor(sla: string) {
  if (sla === 'Missed') return { color: '#DC2626', dot: '#EF4444' };
  if (sla === 'Approaching') return { color: '#B45309', dot: '#EAB308' };
  return { color: '#16A34A', dot: '#22C55E' };
}

function bucketBadgeClass(bucket: Bucket) {
  if (bucket === 'New Delta') return 'ws-badge ws-badge--outline ws-badge--bucket-new';
  if (bucket === 'In Progress') return 'ws-badge ws-badge--outline ws-badge--bucket-progress';
  if (bucket === 'Changed') return 'ws-badge ws-badge--outline ws-badge--bucket-changed';
  return 'ws-badge ws-badge--outline ws-badge--bucket-resolved';
}

function suggestedPriority(sev: Severity): string {
  if (sev === 'Critical') return 'P1 — fix this sprint';
  if (sev === 'High') return 'P2 — next sprint';
  if (sev === 'Medium') return 'P3 — backlog';
  return 'P4 — routine';
}

const SEV_RANK: Record<Severity, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };

export default function AITriage() {
  const { project } = useProject();
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [fService, setFService] = useState('all');
  const [fSeverity, setFSeverity] = useState('all');
  const [fSla, setFSla] = useState('all');
  const [fBucket, setFBucket] = useState('all');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<'severity' | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [reassigning, setReassigning] = useState(false);
  const [reassigningService, setReassigningService] = useState(false);
  const [customServiceMode, setCustomServiceMode] = useState(false);
  const [customService, setCustomService] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    listFindings(project.id)
      .then(({ findings: fetched }) => {
        if (!cancelled) setFindings(fetched);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load findings. Please try again.');
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const services = useMemo(
    () => Array.from(new Set((findings ?? []).map((f) => f.service))).sort(),
    [findings],
  );

  // The project's own declared services (set up in New Project / Settings)
  // — this is the taxonomy findings actually get tagged into, distinct from
  // `services` above which is just whatever values already showed up in the
  // ingested findings (including "Unassigned").
  const projectServices = project?.services ?? [];

  const filtered = useMemo(() => {
    let list = (findings ?? []).filter(
      (r) =>
        (fService === 'all' || r.service === fService) &&
        (fSeverity === 'all' || r.severity === fSeverity) &&
        (fSla === 'all' || r.sla === fSla) &&
        (fBucket === 'all' || r.bucket === fBucket),
    );
    if (sortKey === 'severity') list = [...list].sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) * sortDir);
    return list;
  }, [findings, fService, fSeverity, fSla, fBucket, sortKey, sortDir]);

  const selCount = Object.values(selected).filter(Boolean).length;
  const openRow = (findings ?? []).find((r) => r.id === openId) ?? null;

  const updateLocalFinding = (updated: Finding) => {
    setFindings((prev) => (prev ? prev.map((f) => (f.id === updated.id ? updated : f)) : prev));
  };

  const toggleRow = (row: Finding) => {
    if (row.ticketKey) return; // already has a ticket — nothing to select
    if (!canEdit(project?.myRole)) return;
    setSelected((prev) => ({ ...prev, [row.id]: !prev[row.id] }));
  };

  const toggleSort = (key: 'severity') => {
    if (sortKey === key) setSortDir((d) => (d === -1 ? 1 : -1));
    else {
      setSortKey(key);
      setSortDir(-1);
    }
  };

  const arrow = (key: 'severity') => (sortKey === key ? (sortDir === -1 ? '↓' : '↑') : '↕');

  const handleReassign = async (bucket: Bucket) => {
    if (!project || !openRow) return;
    setBusy(true);
    setActionError(null);
    try {
      const { finding } = await reassignFindingBucket(project.id, openRow.id, bucket);
      updateLocalFinding(finding);
      setReassigning(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not reassign this finding.');
    } finally {
      setBusy(false);
    }
  };

  const handleReassignService = async (service: string) => {
    if (!project || !openRow || !service.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      const { finding } = await reassignFindingService(project.id, openRow.id, service.trim());
      updateLocalFinding(finding);
      setReassigningService(false);
      setCustomServiceMode(false);
      setCustomService('');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not reassign this finding.');
    } finally {
      setBusy(false);
    }
  };

  const handleMarkForJira = async (findingIds: string[]) => {
    if (!project) return;
    // Defensive filter — a finding that already has a ticket should never be
    // re-submitted, whether it got here via a stale checkbox selection or a
    // direct call. The backend also guards against duplicates, but this
    // keeps it from even trying.
    const eligibleIds = findingIds.filter((id) => !findings?.find((f) => f.id === id)?.ticketKey);
    if (eligibleIds.length === 0) return;

    setBusy(true);
    setActionError(null);
    try {
      await createTickets(project.id, eligibleIds);
      const { findings: refreshed } = await listFindings(project.id);
      setFindings(refreshed);
      setSelected({});
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not create tickets for the selected findings.');
    } finally {
      setBusy(false);
    }
  };

  const handleReopenTicket = async () => {
    if (!project || !openRow?.ticketId) return;
    setBusy(true);
    setActionError(null);
    try {
      await reopenTicket(project.id, openRow.ticketId);
      const { findings: refreshed } = await listFindings(project.id);
      setFindings(refreshed);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not reopen this ticket.');
    } finally {
      setBusy(false);
    }
  };

  const canReopenTicket = (row: Finding) =>
    row.bucket !== 'Resolved' && row.ticketStatus === 'Done' && !!row.ticketId;

  if (loadError) {
    return (
      <main className="ws-page">
        <WorkspaceBreadcrumb current="AI Triage" />
        <div className="ws-divider" />
        <div className="ws-empty">
          <div className="ws-empty-title">{loadError}</div>
        </div>
      </main>
    );
  }

  return (
    <main className="ws-page">
      <WorkspaceBreadcrumb current="AI Triage" />
      <div className="ws-divider" />

      <div className="ws-header-row">
        <div>
          <div className="ws-header-eyebrow">{findings ? `${findings.length} findings` : 'Loading…'}</div>
          <h2 className="ws-header-title">Review AI decisions</h2>
        </div>
        <div className="triage-filters">
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
          <select className="ws-select" value={fSla} onChange={(e) => setFSla(e.target.value)}>
            <option value="all">Any SLA status</option>
            <option value="Missed">Missed</option>
            <option value="Approaching">Approaching</option>
            <option value="On track">On track</option>
          </select>
          <select className="ws-select" value={fBucket} onChange={(e) => setFBucket(e.target.value)}>
            <option value="all">All buckets</option>
            {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>

      {actionError && <div className="new-project-error" role="alert" style={{ marginBottom: 14 }}>{actionError}</div>}

      {selCount > 0 && (
        <div className="triage-bulk-toolbar">
          <span className="triage-bulk-count">{selCount} selected</span>
          <span style={{ flex: 1 }} />
          <button className="triage-bulk-clear" onClick={() => setSelected({})}>Clear</button>
          <button
            className="triage-bulk-create"
            disabled={busy || !canEdit(project?.myRole)}
            onClick={() => void handleMarkForJira(Object.keys(selected).filter((id) => selected[id]))}
          >
            Create {selCount} ticket(s)
          </button>
        </div>
      )}

      {!findings ? (
        <div className="page-subtitle">Loading findings…</div>
      ) : findings.length === 0 ? (
        <div className="ws-empty">
          <div className="ws-empty-title">No findings yet</div>
          <div className="ws-empty-body">Upload a scan from Report Intake to populate this list.</div>
        </div>
      ) : (
        <section className="ws-table">
          <div className="ws-table-head triage-grid">
            <span></span>
            <span>ID</span>
            <span>Finding</span>
            <span>Service</span>
            <button className="triage-sort-btn" onClick={() => toggleSort('severity')}>Severity {arrow('severity')}</button>
            <span>SLA status</span>
            <span>AI bucket</span>
            <span className="ws-col-right">Action</span>
          </div>
          {filtered.map((r) => {
            const checked = !!selected[r.id];
            const sla = slaColor(r.sla);
            return (
              <div
                key={r.id}
                className="ws-table-row ws-table-row--clickable triage-grid"
                style={{
                  background: checked ? '#EFF6FF' : openId === r.id ? 'var(--color-bg)' : 'transparent',
                  opacity: r.ticketKey && !canReopenTicket(r) ? 0.45 : 1,
                }}
                onClick={() => {
                  setOpenId(r.id);
                  setReassigning(false);
                  setReassigningService(false);
                  setCustomServiceMode(false);
                  setCustomService('');
                }}
              >
                <span
                  className="triage-checkbox-cell"
                  style={r.ticketKey ? { cursor: 'default' } : undefined}
                  title={r.ticketKey ? `Already ticketed as ${r.ticketKey}` : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRow(r);
                  }}
                >
                  <span className={`ws-checkbox ${checked ? 'ws-checkbox--checked' : ''}`} style={r.ticketKey ? { opacity: 0.35 } : undefined}>
                    {checked ? '✓' : ''}
                  </span>
                </span>
                <span className="ws-mono triage-id">{r.externalId ?? r.id.slice(0, 8)}</span>
                <span className="triage-title">{r.title}</span>
                <span className="triage-service">{r.service}</span>
                <span><span className={sevBadgeClass(r.severity)}>{r.severity}</span></span>
                <span className="ws-dot-status" style={{ color: sla.color }}><span className="ws-dot" style={{ background: sla.dot }} />{r.sla}</span>
                <span><span className={bucketBadgeClass(r.bucket)}>{r.bucket}</span></span>
                <span className="ws-col-right triage-review-link">
                  {canReopenTicket(r) ? 'Reopen' : (r.ticketKey ?? 'Review')}
                </span>
              </div>
            );
          })}
          <div className="triage-count-label">{filtered.length} of {findings.length} findings</div>
        </section>
      )}

      {openRow && (
        <>
          <div className="triage-drawer-backdrop" onClick={() => setOpenId(null)} />
          <div className="triage-drawer">
            <div className="triage-drawer-header">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="triage-drawer-tags">
                  <span className="ws-mono triage-drawer-id">{openRow.externalId ?? openRow.id.slice(0, 8)}</span>
                  <span className={sevBadgeClass(openRow.severity)} style={{ padding: '3px 9px', fontSize: 10.5 }}>{openRow.severity}</span>
                  <span className={`ws-badge ${openRow.source === 'github_ai' ? 'ws-badge--pill-blue' : 'ws-badge--pill-neutral'}`}>
                    {openRow.source === 'github_ai' ? 'GitHub AI' : openRow.source === 'jira_import' ? 'Jira Import' : 'CSV'}
                  </span>
                  <span className="ws-dot-status" style={{ color: slaColor(openRow.sla).color, fontSize: 11.5 }}>
                    <span className="ws-dot" style={{ width: 6, height: 6, background: slaColor(openRow.sla).dot }} />{openRow.sla}
                  </span>
                </div>
                <div className="triage-drawer-title">{openRow.title}</div>
                <div className="triage-drawer-meta">
                  {openRow.service} · first seen {new Date(openRow.firstSeen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              </div>
              <button className="triage-drawer-close" onClick={() => setOpenId(null)}>✕</button>
            </div>

            <div className="triage-drawer-body">
              <div>
                <div className="triage-drawer-label">FINDING</div>
                <div className="triage-drawer-desc">{openRow.description || 'No description provided in this scan.'}</div>
              </div>
              {openRow.evidence && (
                <div>
                  <div className="triage-drawer-label">EVIDENCE</div>
                  <div className="triage-drawer-evidence">{openRow.evidence}</div>
                </div>
              )}
              {openRow.remediationGuidance && (
                <div>
                  <div className="triage-drawer-label">REMEDIATION GUIDANCE</div>
                  <div className="triage-drawer-desc" style={{ whiteSpace: 'pre-wrap' }}>{openRow.remediationGuidance}</div>
                  {openRow.source === 'github_ai' && openRow.sourceUrl && (
                    <a href={openRow.sourceUrl} target="_blank" rel="noreferrer" className="ws-btn ws-btn-outline-blue" style={{ marginTop: 10, display: 'inline-flex' }}>
                      View file on GitHub{openRow.lineStart ? ` (line ${openRow.lineStart}${openRow.lineEnd && openRow.lineEnd !== openRow.lineStart ? `–${openRow.lineEnd}` : ''})` : ''}
                    </a>
                  )}
                </div>
              )}
              <div>
                <div className="triage-drawer-label">TRIAGE RATIONALE</div>
                <div className="triage-drawer-rationale">{openRow.rationale}</div>
              </div>
              <div className="triage-drawer-meta-grid">
                <div className="triage-drawer-meta-tile">
                  <div className="triage-drawer-meta-tile-label">AI bucket</div>
                  <div className="triage-drawer-meta-tile-value">{openRow.bucket}</div>
                </div>
                <div className="triage-drawer-meta-tile">
                  <div className="triage-drawer-meta-tile-label">Suggested priority</div>
                  <div className="triage-drawer-meta-tile-value">{suggestedPriority(openRow.severity)}</div>
                </div>
              </div>
              {openRow.ticketKey && (
                <div className="triage-drawer-meta-tile">
                  <div className="triage-drawer-meta-tile-label">Ticket</div>
                  <div className="triage-drawer-meta-tile-value">
                    {openRow.ticketKey}
                    {openRow.ticketStatus ? ` · ${openRow.ticketStatus}` : ''}
                  </div>
                </div>
              )}
            </div>

            <div className="triage-drawer-actions">
              {reassigning ? (
                <select
                  className="ws-select"
                  style={{ flex: 1 }}
                  autoFocus
                  disabled={busy}
                  defaultValue=""
                  onChange={(e) => e.target.value && void handleReassign(e.target.value as Bucket)}
                  onBlur={() => setReassigning(false)}
                >
                  <option value="" disabled>Reassign to…</option>
                  {BUCKETS.filter((b) => b !== openRow.bucket).map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              ) : reassigningService && customServiceMode ? (
                <form
                  style={{ display: 'flex', flex: 1, gap: 8 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleReassignService(customService);
                  }}
                >
                  <input
                    type="text"
                    className="ws-select"
                    style={{ flex: 1 }}
                    autoFocus
                    disabled={busy}
                    placeholder="Service name…"
                    value={customService}
                    onChange={(e) => setCustomService(e.target.value)}
                  />
                  <button type="submit" className="ws-btn ws-btn-secondary" disabled={busy || !customService.trim()}>
                    Save
                  </button>
                </form>
              ) : reassigningService ? (
                <select
                  className="ws-select"
                  style={{ flex: 1 }}
                  autoFocus
                  disabled={busy}
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value === '__custom__') setCustomServiceMode(true);
                    else if (e.target.value) void handleReassignService(e.target.value);
                  }}
                  onBlur={() => setReassigningService(false)}
                >
                  <option value="" disabled>Reassign service to…</option>
                  {projectServices.filter((s) => s !== openRow.service).map((s) => <option key={s} value={s}>{s}</option>)}
                  <option value="__custom__">Custom…</option>
                </select>
              ) : (
                <>
                  <button className="ws-btn ws-btn-success" style={{ flex: 1 }} onClick={() => setOpenId(null)}>Accept</button>
                  <button
                    className="ws-btn ws-btn-secondary"
                    style={{ flex: 1 }}
                    disabled={!canEdit(project?.myRole)}
                    title={!canEdit(project?.myRole) ? 'Your role does not allow reassigning findings.' : undefined}
                    onClick={() => setReassigning(true)}
                  >
                    Reassign bucket
                  </button>
                  <button
                    className="ws-btn ws-btn-secondary"
                    style={{ flex: 1 }}
                    disabled={!canEdit(project?.myRole)}
                    title={!canEdit(project?.myRole) ? 'Your role does not allow reassigning findings.' : undefined}
                    onClick={() => setReassigningService(true)}
                  >
                    Reassign service
                  </button>
                  <button
                    className="ws-btn ws-btn-outline-blue"
                    style={{ flex: 1 }}
                    disabled={
                      busy ||
                      !canEdit(project?.myRole) ||
                      (!!openRow.ticketKey && !canReopenTicket(openRow))
                    }
                    title={
                      !canEdit(project?.myRole)
                        ? 'Your role does not allow creating tickets.'
                        : canReopenTicket(openRow)
                          ? `Reopen ${openRow.ticketKey} so remediation can continue`
                          : undefined
                    }
                    onClick={() => {
                      if (canReopenTicket(openRow)) void handleReopenTicket();
                      else void handleMarkForJira([openRow.id]);
                    }}
                  >
                    {canReopenTicket(openRow)
                      ? `Reopen ticket · ${openRow.ticketKey}`
                      : openRow.ticketKey
                        ? `Ticketed · ${openRow.ticketKey}`
                        : 'Mark for Jira'}
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
