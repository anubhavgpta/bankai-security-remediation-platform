import { useEffect, useState, type ReactElement } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import { logout } from '../lib/api';
import { getAvatarStyle, getDisplayName, getInitials, useCurrentUser } from '../lib/auth-context';
import { useProject } from '../lib/project-context';
import './Sidebar.css';

const ICONS: Record<string, ReactElement> = {
  workflow: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6.5h9a3 3 0 0 1 0 6H7a3 3 0 0 0 0 6h9" />
      <circle cx="3" cy="6.5" r="1.6" />
      <circle cx="17" cy="18.5" r="1.6" />
    </svg>
  ),
  overview: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 2.5a7.5 7.5 0 1 0 7.5 7.5H10V2.5Z" />
      <path d="M13 2.9a7.5 7.5 0 0 1 4.1 4.1H13V2.9Z" />
    </svg>
  ),
  intake: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3v8.5" />
      <path d="M6.5 8.5 10 12l3.5-3.5" />
      <path d="M3 13.5v2A1.5 1.5 0 0 0 4.5 17h11a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </svg>
  ),
  triage: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3v14M14 3v14" />
      <path d="M3.5 7.5h5M11.5 12.5h5" />
    </svg>
  ),
  tickets: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5v-1A1.5 1.5 0 0 1 4.5 5h11A1.5 1.5 0 0 1 17 6.5v1a2.5 2.5 0 0 0 0 5v1a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 13.5v-1a2.5 2.5 0 0 0 0-5Z" />
      <path d="M12.5 5v10" strokeDasharray="2 2.2" />
    </svg>
  ),
  activity: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 10h3.2l2.1-5 3.9 10 2.1-5h3.7" />
    </svg>
  ),
};

const NAV_ITEMS = [
  { key: 'workflow', label: 'Remediation Workflow', path: 'workflow' },
  { key: 'overview', label: 'Overview', path: 'overview' },
  { key: 'intake', label: 'Report Intake', path: 'intake' },
  { key: 'triage', label: 'AI Triage', path: 'triage' },
  { key: 'tickets', label: 'Tickets', path: 'tickets' },
  { key: 'activity', label: 'Activity', path: 'activity' },
];

const STORAGE_KEY = 'bankai-sidebar-collapsed';

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const { user, setUser } = useCurrentUser();
  const { project } = useProject();
  const projectId = project?.id;

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
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') setCollapsed(true);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const expanded = !collapsed;

  return (
    <aside className="sidebar-outer">
      <div className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
        <div className={`sidebar-header ${expanded ? '' : 'sidebar-header--collapsed'}`}>
          <NavLink to="/projects" className="sidebar-brand">
            <img src={bankaiMark} alt="Bankai" className="sidebar-brand-mark" />
            {expanded && <img src={bankaiWordmark} alt="BANKAI" className="sidebar-brand-wordmark" />}
          </NavLink>
        </div>

        <nav className={`sidebar-nav ${expanded ? '' : 'sidebar-nav--collapsed'}`}>
          {expanded && <div className="sidebar-nav-label">Navigation</div>}
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.key}
              to={`/workspace/${projectId}/${item.path}`}
              title={item.label}
              className={({ isActive }) =>
                `sidebar-nav-item ${isActive ? 'sidebar-nav-item--active' : ''} ${expanded ? '' : 'sidebar-nav-item--collapsed'}`
              }
            >
              <span className="sidebar-nav-icon">{ICONS[item.key]}</span>
              {expanded && <span className="sidebar-nav-label-text">{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className={`sidebar-toggle-row ${expanded ? '' : 'sidebar-toggle-row--collapsed'}`}>
          <button
            onClick={toggle}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="sidebar-toggle-btn"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2.5"></rect>
              <line x1="6" y1="2.5" x2="6" y2="13.5"></line>
            </svg>
          </button>
        </div>

        <div className={`sidebar-user ${expanded ? '' : 'sidebar-user--collapsed'}`}>
          <div className="avatar-ring" style={getAvatarStyle(user)}>{getInitials(user)}</div>
          {expanded && (
            <>
              <div className="sidebar-user-info">
                <div className="sidebar-user-name">{getDisplayName(user)}</div>
                {user?.email && <div className="sidebar-user-email">{user.email}</div>}
              </div>
              <button className="sidebar-user-menu-btn" onClick={() => setMenuOpen((v) => !v)}>
                ⋯
              </button>
            </>
          )}

          {menuOpen && (
            <>
              <div className="sidebar-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="sidebar-menu">
                <NavLink to={`/workspace/${projectId}/settings`} className="sidebar-menu-item" onClick={() => setMenuOpen(false)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                  </svg>
                  Settings
                </NavLink>
                <a
                  href="/login"
                  className="sidebar-menu-item sidebar-menu-item--danger"
                  onClick={(e) => {
                    e.preventDefault();
                    void handleSignOut();
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17H8"></path>
                    <path d="M13 13.5 17 10l-4-3.5"></path>
                    <path d="M17 10H8"></path>
                  </svg>
                  Sign out
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
