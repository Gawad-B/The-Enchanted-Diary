import { ErrorBoundary } from './components/ErrorBoundary';
import { ExperienceShell } from './components/ExperienceShell';
import { SkipLink } from './ui/fallback/SkipLink';

export function App() {
  return (
    <ErrorBoundary>
      <SkipLink />
      <ExperienceShell />
    </ErrorBoundary>
  );
}
