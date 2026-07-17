import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import { ApiError, listScans, uploadScan, type Scan } from '../../lib/api';
import { useProject } from '../../lib/project-context';
import './ReportIntake.css';

type Mode = 'empty' | 'uploading' | 'done' | 'error';

const STEP_DEFS = [
  { label: 'Uploading file', t: 20 },
  { label: 'Parsing CSV', t: 45 },
  { label: 'Diffing against prior findings', t: 75 },
  { label: 'Saving results', t: 90 },
];

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ReportIntake() {
  const { project } = useProject();
  const [mode, setMode] = useState<Mode>('empty');
  const [progress, setProgress] = useState(0);
  const [fileMeta, setFileMeta] = useState<{ name: string; size: number } | null>(null);
  const [result, setResult] = useState<Scan | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<Scan[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadHistory = () => {
    if (!project) return;
    listScans(project.id)
      .then(({ scans }) => setHistory(scans))
      .catch(() => setHistory([]));
  };

  useEffect(() => {
    loadHistory();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const startUpload = async (file: File) => {
    if (!project) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setMode('error');
      setErrorMessage('Only CSV files are supported.');
      return;
    }

    setFileMeta({ name: file.name, size: file.size });
    setMode('uploading');
    setProgress(0);

    if (timerRef.current) clearInterval(timerRef.current);
    // The steps below are a decorative stand-in for real progress — parsing
    // and saving happen server-side in one request, so this just animates
    // up to 90% while the request is in flight and jumps to 100% on response.
    timerRef.current = setInterval(() => {
      setProgress((p) => (p >= 90 ? 90 : p + 3));
    }, 120);

    try {
      const { scan } = await uploadScan(project.id, file);
      if (timerRef.current) clearInterval(timerRef.current);
      setProgress(100);
      setResult(scan);
      setMode('done');
      loadHistory();
    } catch (err) {
      if (timerRef.current) clearInterval(timerRef.current);
      setMode('error');
      setErrorMessage(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      loadHistory();
    }
  };

  const retry = () => {
    setMode('empty');
    setProgress(0);
    setResult(null);
    setErrorMessage(null);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void startUpload(file);
    e.target.value = '';
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void startUpload(file);
  };

  let activeFound = false;
  const steps = STEP_DEFS.map((d) => {
    const done = progress >= d.t;
    const active = !done && !activeFound && (activeFound = true);
    return { ...d, done, active };
  });

  return (
    <main className="ws-page">
      <WorkspaceBreadcrumb current="Report Intake" />
      <div className="ws-divider" />

      <section className="ws-card intake-card">
        <div className="intake-card-header">
          <div className="ws-card-eyebrow">Step 1 of 3</div>
          <h2 className="intake-card-title">Report Intake &amp; Triage</h2>
          <div className="intake-card-sub">
            Upload your vulnerability scan CSV. Bankai parses it, diffs it against this project&apos;s existing
            findings, and splits results by service.
          </div>
        </div>

        {mode === 'empty' && (
          <div
            className="ws-dropzone"
            style={dragOver ? { borderColor: 'var(--color-blue)', background: 'var(--color-surface-alt)' } : undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <svg width="64" height="52" viewBox="0 0 64 52" fill="none" stroke="var(--color-text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 40h-4.5C8 40 3.5 35.5 3.5 30c0-5 3.7-9.1 8.5-9.9C13.3 12.6 19.9 6.5 28 6.5c7 0 13 4.5 15.2 10.8 6.6 0.3 11.8 5.7 11.8 12.3 0 5.8-4.1 9.7-9.5 10.4" />
              <circle cx="32" cy="38" r="10.5" fill="var(--color-bg)" />
              <path d="M27.5 38.5 30.8 41.8 36.8 34.8" />
            </svg>
            <div className="ws-dropzone-title">Drag and drop your CSV here or choose a file</div>
            <div className="ws-dropzone-body">CSV up to 10 MB. One scan export per intake — Bankai diffs it against the previous state.</div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={handleFileInputChange}
            />
            <button onClick={() => fileInputRef.current?.click()} className="ws-btn ws-btn-primary" style={{ marginTop: 20 }}>
              Browse File
            </button>
          </div>
        )}

        {mode === 'uploading' && fileMeta && (
          <div className="intake-processing">
            <div className="intake-processing-header">
              <div className="intake-file-icon">CSV</div>
              <div className="intake-processing-info">
                <div className="intake-processing-filename">{fileMeta.name}</div>
                <div className="intake-processing-meta">{formatBytes(fileMeta.size)} · uploading now</div>
              </div>
              <div className="intake-processing-pct">{progress}%</div>
            </div>
            <div className="ws-progress-track" style={{ margin: '16px 0 22px 0' }}>
              <div className="ws-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="intake-steps">
              {steps.map((s) => (
                <div key={s.label} className="intake-step-row">
                  <span
                    className="intake-step-mark"
                    style={{
                      background: s.done ? 'var(--color-green)' : s.active ? 'var(--color-blue)' : 'transparent',
                      border: s.done || s.active ? 'none' : '1.5px solid var(--color-text-faint)',
                      animation: s.active ? 'ws-pulse 1.2s ease-in-out infinite' : 'none',
                    }}
                  >
                    {s.done ? '✓' : ''}
                  </span>
                  <span
                    className="intake-step-label"
                    style={{
                      fontWeight: s.done || s.active ? 600 : 500,
                      color: s.done ? 'var(--color-text)' : s.active ? 'var(--color-blue)' : 'var(--color-text-muted)',
                    }}
                  >
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {mode === 'done' && result && (
          <div className="intake-done">
            <div className="intake-done-header">
              <span className="intake-done-check">✓</span>
              <div>
                <div className="intake-done-title">{result.filename} processed</div>
                <div className="intake-done-meta">{new Date(result.createdAt).toLocaleString()}</div>
              </div>
            </div>
            <div className="intake-done-stats">
              <div className="ws-stat-tile"><div className="ws-stat-tile-value" style={{ fontSize: 24 }}>{result.rowCount}</div><div className="ws-stat-tile-label">Rows found</div></div>
              <div className="ws-stat-tile"><div className="ws-stat-tile-value" style={{ fontSize: 24 }}>{result.serviceCount}</div><div className="ws-stat-tile-label">Services detected</div></div>
              <div className="ws-stat-tile"><div className="ws-stat-tile-value" style={{ fontSize: 24 }}>{result.newDeltaCount}</div><div className="ws-stat-tile-label">New delta rows</div></div>
              <div className="ws-stat-tile"><div className="ws-stat-tile-value" style={{ fontSize: 24 }}>{result.inProgressCount}</div><div className="ws-stat-tile-label">Already in progress</div></div>
            </div>
            <div className="intake-done-actions">
              <Link to={`/workspace/${project?.id}/triage`} className="ws-btn ws-btn-primary" style={{ padding: '10px 24px', fontSize: 13.5 }}>View Triage</Link>
              <button onClick={retry} className="intake-download-link" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>Upload another scan</button>
            </div>
          </div>
        )}

        {mode === 'error' && (
          <div className="intake-error">
            <span className="intake-error-icon">!</span>
            <div className="intake-error-body">
              <div className="intake-error-title">Intake failed</div>
              <div className="intake-error-text">{errorMessage}</div>
              <div className="intake-error-actions">
                <button onClick={retry} className="ws-btn" style={{ background: '#DC2626', color: '#fff', padding: '9px 22px', fontSize: 13 }}>Try again</button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="ws-card">
        <div className="ws-card-eyebrow">History</div>
        <h2 className="ws-card-title">Past intakes</h2>
        {history === null ? (
          <div className="page-subtitle">Loading…</div>
        ) : history.length === 0 ? (
          <div className="page-subtitle">No scans uploaded yet.</div>
        ) : (
          <>
            <div className="intake-history-head">
              <span>Filename</span><span>Date</span><span className="ws-col-right">Rows</span><span className="ws-col-right">Services</span><span>Status</span><span className="ws-col-right">Deltas</span>
            </div>
            {history.map((row) => (
              <div key={row.id} className="intake-history-row">
                <span className="intake-history-filename">{row.filename}</span>
                <span className="intake-history-date">{formatDate(row.createdAt)}</span>
                <span className="ws-col-right">{row.status === 'Done' ? row.rowCount : '—'}</span>
                <span className="ws-col-right">{row.status === 'Done' ? row.serviceCount : '—'}</span>
                <span><span className={`ws-badge ${row.status === 'Done' ? 'ws-badge--pill-green' : 'ws-badge--pill-red'}`}>{row.status}</span></span>
                <span className="ws-col-right">{row.status === 'Done' ? `+${row.newDeltaCount}` : row.errorMessage ?? '—'}</span>
              </div>
            ))}
          </>
        )}
      </section>
    </main>
  );
}
