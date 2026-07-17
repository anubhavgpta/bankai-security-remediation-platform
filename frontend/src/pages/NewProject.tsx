import { useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import { ApiError, createProject } from '../lib/api';
import { getAvatarStyle, getInitials, useCurrentUser } from '../lib/auth-context';
import './NewProject.css';

export default function NewProject() {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [newService, setNewService] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const removeService = (index: number) => {
    setServices((prev) => prev.filter((_, i) => i !== index));
  };

  const addService = () => {
    const value = newService.trim();
    if (!value) return;
    setServices((prev) => [...prev, value]);
    setNewService('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addService();
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Project name is required');
      return;
    }

    setSubmitting(true);
    try {
      const { project } = await createProject({
        name,
        description: description.trim() || undefined,
        services,
      });
      navigate(`/workspace/${project.id}/intake`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.fieldErrors?.[0]?.message ?? err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="new-project-page">
      <div className="new-project-topbar">
        <div className="new-project-brand">
          <img src={bankaiMark} alt="Bankai" className="new-project-brand-mark" />
          <img src={bankaiWordmark} alt="BANKAI" className="new-project-brand-wordmark" />
        </div>
        <div className="avatar-ring" style={getAvatarStyle(user)}>{getInitials(user)}</div>
      </div>

      <main className="new-project-main">
        <div className="new-project-breadcrumb">
          <Link to="/projects" className="new-project-breadcrumb-link">Bankai</Link>
          <span className="new-project-breadcrumb-sep">›</span>
          <span className="new-project-breadcrumb-current">New project</span>
        </div>
        <div className="new-project-divider" />

        <div className="new-project-eyebrow">Workspace</div>
        <h1 className="new-project-title">New project</h1>
        <div className="new-project-subtitle">
          Connect a scanner feed to a new project. You can upload the first scan right after.
        </div>

        <form onSubmit={handleCreate}>
          {error && <div className="new-project-error" role="alert">{error}</div>}

          <section className="new-project-section">
            <div className="new-project-step">Step 1</div>
            <h2 className="new-project-section-title">Project details</h2>
            <div className="new-project-field-stack">
              <div className="new-project-field">
                <label htmlFor="project-name">Project name</label>
                <input
                  id="project-name"
                  type="text"
                  placeholder="e.g. Payments Platform"
                  className="new-project-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="new-project-field">
                <label htmlFor="project-description">
                  Description <span className="new-project-optional">(optional)</span>
                </label>
                <textarea
                  id="project-description"
                  placeholder="What does this project cover?"
                  rows={2}
                  className="new-project-textarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
          </section>

          <section className="new-project-section">
            <div className="new-project-step">Step 2</div>
            <h2 className="new-project-section-title new-project-section-title--tight">Services</h2>
            <div className="new-project-section-hint">
              CVITs from this project&apos;s scans will be split and tracked per service.
            </div>

            {services.length > 0 && (
              <div className="new-project-chips">
                {services.map((serviceName, i) => (
                  <span key={`${serviceName}-${i}`} className="new-project-chip">
                    {serviceName}
                    <button
                      type="button"
                      className="new-project-chip-remove"
                      onClick={() => removeService(i)}
                      aria-label={`Remove ${serviceName}`}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="new-project-add-row">
              <input
                type="text"
                value={newService}
                onChange={(e) => setNewService(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Add a service name…"
                className="new-project-add-input"
              />
              <button type="button" className="new-project-add-btn" onClick={addService}>
                Add
              </button>
            </div>
          </section>

          <section className="new-project-section new-project-section--stub">
            <div className="new-project-step">Step 3</div>
            <h2 className="new-project-section-title new-project-section-title--tight">
              Connect Jira <span className="new-project-optional">(coming soon)</span>
            </h2>
            <div className="new-project-section-hint">
              Jira sync isn&apos;t wired up yet, so this step is disabled — tickets won&apos;t be created automatically.
              You can create the project without it and connect Jira later once it&apos;s supported.
            </div>
            <div className="new-project-jira-grid">
              <div className="new-project-field">
                <label htmlFor="jira-site">Jira site</label>
                <input
                  id="jira-site"
                  type="text"
                  placeholder="Coming soon"
                  className="new-project-input"
                  disabled
                />
              </div>
              <div className="new-project-field">
                <label htmlFor="jira-key">Project key</label>
                <input
                  id="jira-key"
                  type="text"
                  placeholder="Coming soon"
                  className="new-project-input new-project-input--upper"
                  disabled
                />
              </div>
            </div>
          </section>

          <div className="new-project-actions">
            <button type="submit" className="new-project-create-btn" disabled={submitting}>
              {submitting ? 'Creating project…' : 'Create project'}
            </button>
            <Link to="/projects" className="new-project-cancel-link">Cancel</Link>
          </div>
        </form>
      </main>
    </div>
  );
}
