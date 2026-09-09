/**
 * Chart selection.
 *
 * Two views of one picture. The platform chart comes first and is the default,
 * because it is the one that works with no external service and is therefore
 * the one an operator can always rely on; the Google chart is a second tab for
 * the times when real imagery makes the situation easier to explain - typically
 * a demonstration or a briefing.
 *
 * Only the selected chart is mounted. Keeping the other alive in a hidden
 * container gives it a zero-sized canvas, which both map libraries handle
 * badly; remounting costs a re-frame and nothing else.
 */

import { useState } from 'react';
import { Tabs } from '../components/ui';
import { MapView } from './MapView';
import { FleetMap } from './FleetMap';
import { GoogleMapView } from './GoogleMapView';
import { GoogleFleetMap } from './GoogleFleetMap';
import type { FleetVessel, NavigationOutput } from '../types';

type ChartTab = 'platform' | 'google';

const CHART_TABS: Array<{ id: ChartTab; label: string }> = [
  { id: 'platform', label: 'Platform chart' },
  { id: 'google', label: 'Google map' }
];

function TabStrip({ value, onChange }: { value: ChartTab; onChange: (id: ChartTab) => void }) {
  return (
    <div className="px-2">
      <Tabs tabs={CHART_TABS} value={value} onChange={onChange} />
    </div>
  );
}

/** The navigation chart, on either basemap. Drop-in for a bare `MapView`. */
export function NavigationChartTabs({
  navigation,
  className = '',
  showControls = true
}: {
  navigation: NavigationOutput | null;
  className?: string;
  showControls?: boolean;
}) {
  const [tab, setTab] = useState<ChartTab>('platform');
  // The tab strip already draws the outer frame, so the chart inside it drops
  // its own border rather than nesting one inside the other.
  const inner = `${className} !rounded-none !border-0`;

  return (
    <section className="overflow-hidden rounded-lg border border-bridge-700 bg-bridge-900">
      <TabStrip value={tab} onChange={setTab} />
      {tab === 'platform' ? (
        <MapView navigation={navigation} className={inner} showControls={showControls} />
      ) : (
        <GoogleMapView navigation={navigation} className={inner} showControls={showControls} />
      )}
    </section>
  );
}

/** The fleet chart, on either basemap. Drop-in for a bare `FleetMap`. */
export function FleetChartTabs({
  vessels,
  selectedId,
  onSelect,
  className = ''
}: {
  vessels: FleetVessel[];
  selectedId: string | null;
  onSelect?: (vesselId: string) => void;
  className?: string;
}) {
  const [tab, setTab] = useState<ChartTab>('platform');

  return (
    <>
      <TabStrip value={tab} onChange={setTab} />
      {tab === 'platform' ? (
        <FleetMap vessels={vessels} selectedId={selectedId} onSelect={onSelect} className={className} />
      ) : (
        <GoogleFleetMap vessels={vessels} selectedId={selectedId} onSelect={onSelect} className={className} />
      )}
    </>
  );
}
