import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getProject, type Project } from './api';

interface ProjectContextValue {
  project: Project | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

export function ProjectProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getProject(projectId)
      .then(({ project: fetched }) => {
        if (!cancelled) setProject(fetched);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this project.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, refreshTick]);

  const refresh = () => setRefreshTick((t) => t + 1);

  return <ProjectContext.Provider value={{ project, loading, error, refresh }}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used within a ProjectProvider');
  return ctx;
}
