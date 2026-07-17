import { Link } from 'react-router-dom';
import { useProject } from '../lib/project-context';

export default function WorkspaceBreadcrumb({ current }: { current: string }) {
  const { project } = useProject();

  return (
    <div className="ws-breadcrumb">
      <Link to="/projects" className="ws-breadcrumb-link">Bankai</Link>
      <span className="ws-breadcrumb-sep">›</span>
      <Link to={project ? `/workspace/${project.id}/workflow` : '#'} className="ws-breadcrumb-link">
        {project?.name ?? '…'}
      </Link>
      <span className="ws-breadcrumb-sep">›</span>
      <span className="ws-breadcrumb-current">{current}</span>
    </div>
  );
}
