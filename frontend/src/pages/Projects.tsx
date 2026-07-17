import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import { listProjects, logout, type Project } from '../lib/api';
import { getAvatarStyle, getDisplayName, getInitials, useCurrentUser } from '../lib/auth-context';
import './TopBar.css';
import './Projects.css';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function Projects() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { user, setUser } = useCurrentUser();

  const handleSignOut = async () => {
    setMenuOpen(false);
    try {
      await logout();
    } catch {
      // Cookies may already be gone (e.g. expired session) — clearing local
      // state and navigating away is still the right outcome either way.
    }
    setUser(null);
    navigate('/login');
  };

  useEffect(() => {
    let cancelled = false;

    listProjects()
      .then(({ projects: fetched }) => {
        if (!cancelled) setProjects(fetched);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load projects. Please try again.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const isLoading = projects === null && !error;
  const isEmpty = projects !== null && projects.length === 0;

  return (
    <div className="topbar-page">
      <div className="topbar">
        <Link to="/projects" className="topbar-brand">
          <img src={bankaiMark} alt="Bankai" className="topbar-brand-mark" />
          <img src={bankaiWordmark} alt="BANKAI" className="topbar-brand-wordmark" />
        </Link>
        <div className="topbar-user">
          <div className="avatar-ring" style={getAvatarStyle(user)}>{getInitials(user)}</div>
          <div>
            <div className="topbar-user-name">{getDisplayName(user)}</div>
            {user?.email && <div className="topbar-user-email">{user.email}</div>}
          </div>
          <button className="topbar-user-menu-btn" onClick={() => setMenuOpen((v) => !v)}>⋯</button>

          {menuOpen && (
            <>
              <div className="topbar-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="topbar-menu">
                <Link
                  to="/settings"
                  className="topbar-menu-item"
                  onClick={() => setMenuOpen(false)}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                  </svg>
                  Settings
                </Link>
                <button
                  className="topbar-menu-item topbar-menu-item--danger"
                  onClick={() => void handleSignOut()}
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17H8"></path>
                    <path d="M13 13.5 17 10l-4-3.5"></path>
                    <path d="M17 10H8"></path>
                  </svg>
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <main className="page-main">
        <div className="page-eyebrow">Workspace</div>
        <h1 className="page-title">Projects</h1>
        <div className="page-subtitle">Pick a project to open its remediation pipeline.</div>

        {isLoading ? (
          <div className="page-subtitle">Loading projects…</div>
        ) : error ? (
          <div className="projects-empty">
            <div className="projects-empty-title">Something went wrong</div>
            <div className="projects-empty-body">{error}</div>
            <button type="button" className="projects-empty-cta" onClick={() => navigate(0)}>
              Retry
            </button>
          </div>
        ) : isEmpty ? (
          <div className="projects-empty">
            <div className="projects-empty-icon">
              <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="#8A8A8E" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2.5" y="4.5" width="15" height="11" rx="2"></rect>
                <path d="M2.5 8h15"></path>
              </svg>
            </div>
            <div className="projects-empty-title">No projects yet</div>
            <div className="projects-empty-body">
              Connect a scanner export for a project and Bankai will start triaging CVITs into a remediation pipeline.
            </div>
            <Link to="/projects/new" className="projects-empty-cta">+ New project</Link>
          </div>
        ) : (
          <div className="projects-grid">
            {projects!.map((project) =>
              project.status === 'active' ? (
                <Link key={project.id} to={`/workspace/${project.id}/workflow`} className="project-card project-card--active">
                  <div className="project-card-status-row">
                    <span className="project-card-status project-card-status--active">
                      <span className="project-card-status-dot project-card-status-dot--active" />
                      Active
                    </span>
                  </div>
                  <div className="project-card-title">{project.name}</div>
                  {project.services.length > 0 && (
                    <div className="project-card-tags">
                      {project.services.map((service) => (
                        <span key={service} className="project-card-tag">{service}</span>
                      ))}
                    </div>
                  )}
                  <div className="project-card-stats">
                    <div>
                      <div className="project-card-stat-value">{project.stats.totalCvits}</div>
                      <div className="project-card-stat-label">Total CVITs</div>
                    </div>
                    <div>
                      <div className="project-card-stat-value project-card-stat-value--red">{project.stats.slaBreachedPct}%</div>
                      <div className="project-card-stat-label">SLA breached</div>
                    </div>
                    <div>
                      <div className="project-card-stat-value">{project.stats.openTickets}</div>
                      <div className="project-card-stat-label">Open tickets</div>
                    </div>
                  </div>
                  {project.lastIntakeAt && (
                    <div className="project-card-footer">Last intake {formatDate(project.lastIntakeAt)}</div>
                  )}
                </Link>
              ) : (
                <Link key={project.id} to={`/workspace/${project.id}/intake`} className="project-card project-card--muted">
                  <div className="project-card-status-row">
                    <span className="project-card-status">
                      <span className="project-card-status-dot" />
                      Not connected
                    </span>
                  </div>
                  <div className="project-card-title project-card-title--muted">{project.name}</div>
                  <div className="project-card-muted-body">
                    Connect a scanner export for this project to start triaging CVITs.
                  </div>
                  <div className="project-card-footer">Upload a scan →</div>
                </Link>
              ),
            )}

            <Link to="/projects/new" className="project-card-new">
              <div className="project-card-new-icon">+</div>
              <div className="project-card-new-title">New project</div>
              <div className="project-card-new-sub">Connect another scanner feed</div>
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
