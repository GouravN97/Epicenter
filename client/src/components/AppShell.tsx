import { useDisplay } from '../state/displayStore';
import { ControlShell } from './shell/ControlShell';
import { GlassShell } from './shell/GlassShell';
import { Shortcuts } from './Shortcuts';
import { TourGuide } from './TourGuide';

/**
 * The frame around every signed-in page. Each display mode has its own shell (navigation, toolbar,
 * layout); the pages inside are the same and take their look from the theme tokens and the shared
 * component classes in index.css.
 */
export function AppShell() {
  const mode = useDisplay((s) => s.mode);
  return (
    <>
      {mode === 'glass' ? <GlassShell /> : <ControlShell />}
      <TourGuide />
      <Shortcuts />
    </>
  );
}
