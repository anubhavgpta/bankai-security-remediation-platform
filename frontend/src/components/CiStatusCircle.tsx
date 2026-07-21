import type { Ticket } from '../lib/api';

interface CiStatusCircleProps {
  status: Ticket['ciStatus'];
  runUrl: string | null;
  error?: string | null;
  size?: number;
  className?: string;
}

const DEFAULT_LABEL: Record<'queued' | 'running' | 'passed' | 'failed', string> = {
  queued: 'CI verification queued',
  running: 'CI verification running',
  passed: 'CI verification passed',
  failed: 'CI verification failed',
};

export default function CiStatusCircle({ status, runUrl, error, size = 22, className }: CiStatusCircleProps) {
  if (status !== 'queued' && status !== 'running' && status !== 'passed' && status !== 'failed') {
    return null;
  }

  const title = error ?? DEFAULT_LABEL[status];
  const content =
    status === 'queued' || status === 'running' ? (
      <span
        className="ci-spinner"
        style={{ width: size - 6, height: size - 6, color: status === 'queued' ? '#EAB308' : '#2563EB' }}
      />
    ) : status === 'passed' ? (
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8.5 6.2 12 13 4" />
      </svg>
    ) : (
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
        <path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" />
      </svg>
    );

  const sharedStyle = {
    width: size,
    height: size,
    background: status === 'passed' ? '#22C55E' : status === 'failed' ? '#DC2626' : 'transparent',
  };

  const classes = `ci-status-circle ${className ?? ''}`.trim();

  if (runUrl) {
    return (
      <a href={runUrl} target="_blank" rel="noreferrer" className={classes} style={sharedStyle} title={title} onClick={(e) => e.stopPropagation()}>
        {content}
      </a>
    );
  }

  return (
    <span className={classes} style={sharedStyle} title={title}>
      {content}
    </span>
  );
}
