import { Navigate, Outlet, useParams } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import { ProjectProvider, useProject } from '../lib/project-context';
import './Workspace.css';
import './workspace-pages/shared.css';

function WorkspaceShell() {
  const { project, loading, error } = useProject();

  if (error) {
    return (
      <div className="workspace">
        <div className="workspace-content">
          <main className="ws-page">
            <div className="ws-empty">
              <div className="ws-empty-title">{error}</div>
              <div className="ws-empty-body">It may have been deleted, or you may not have access to it.</div>
            </div>
          </main>
        </div>
      </div>
    );
  }

  if (loading || !project) {
    return (
      <div className="workspace">
        <div className="workspace-content">
          <main className="ws-page">Loading project…</main>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace">
      <Sidebar />
      <div className="workspace-content">
        <Outlet />
      </div>
    </div>
  );
}

export default function Workspace() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return <Navigate to="/projects" replace />;

  return (
    <ProjectProvider projectId={projectId}>
      <WorkspaceShell />
    </ProjectProvider>
  );
}
