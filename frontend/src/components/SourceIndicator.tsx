/**
 * Data-source indicator.
 *
 * Every operational monitoring system needs to say, unambiguously, where the
 * data on screen came from: a live sensor feed, a recorded replay, or a
 * simulation. Confusing the three is how an operator ends up acting on a replay,
 * or a demonstration gets mistaken for a vessel at sea.
 *
 * It sits in the header beside the connection state, and it is derived from
 * what the platform is actually doing rather than from a build flag - so it
 * reads LIVE by itself the moment a real feed is connected.
 */

import { useAppSelector } from '../store';

export type DataSource = 'LIVE' | 'REPLAY' | 'SIMULATION' | 'STANDBY';

interface Presentation {
  label: string;
  glyph: string;
  className: string;
  title: string;
}

const PRESENTATION: Record<DataSource, Presentation> = {
  LIVE: {
    label: 'LIVE',
    glyph: '◉',
    className: 'border-assured/50 bg-assured/15 text-assured',
    title: 'Live sensor feed from the vessel.'
  },
  REPLAY: {
    label: 'REPLAY',
    glyph: '⟲',
    className: 'border-info/50 bg-info/15 text-info',
    title: 'Recorded data being played back. Not current vessel state.'
  },
  SIMULATION: {
    label: 'SIMULATION',
    glyph: '◈',
    className: 'border-caution/50 bg-caution/15 text-caution',
    title: 'Simulated sensor data. Positions shown are generated, not measured.'
  },
  STANDBY: {
    label: 'STANDBY',
    glyph: '○',
    className: 'border-bridge-600 bg-bridge-800 text-bridge-400',
    title: 'No data source is running.'
  }
};

/** Work out what is actually feeding the display. */
export function useDataSource(): DataSource {
  const replay = useAppSelector((s) => s.live.replay);
  const scenario = useAppSelector((s) => s.live.scenario);
  const navigation = useAppSelector((s) => s.live.navigation);

  if (replay?.state === 'RUNNING' || replay?.state === 'PAUSED') return 'REPLAY';
  if (scenario?.state === 'RUNNING' || scenario?.state === 'PAUSED') return 'SIMULATION';
  // Solutions arriving with neither a scenario nor a replay running can only
  // have come from ingested sensor data, so the feed is live.
  if (navigation?.solution_available) return 'LIVE';
  return 'STANDBY';
}

export function SourceIndicator({ compact = false }: { compact?: boolean }) {
  const source = useDataSource();
  const presentation = PRESENTATION[source];

  return (
    <span className={`chip ${presentation.className}`} title={presentation.title}>
      <span aria-hidden>{presentation.glyph}</span>
      <span className={compact ? 'sr-only sm:not-sr-only' : ''}>{presentation.label}</span>
    </span>
  );
}
