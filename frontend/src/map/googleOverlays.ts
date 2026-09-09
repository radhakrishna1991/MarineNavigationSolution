/**
 * Drawing the platform's own GeoJSON on a Google map.
 *
 * The primary chart hands MapLibre a style sheet and lets it draw; the Google
 * API has no equivalent, so every feature becomes an overlay object. Doing that
 * here - rather than through `google.maps.Data` - keeps the two charts visually
 * identical: the same colours, the same line weights and the same dash patterns
 * carry the same meaning on both, which is the point of offering a second view
 * of one picture rather than a second picture.
 *
 * Google has no dashed-stroke property. A dash is a repeated icon along a
 * zero-opacity line, so a dashed outline is drawn as its own polyline on top of
 * an unstroked polygon.
 */

export interface GeoStyle {
  strokeColor?: string;
  strokeWeight?: number;
  strokeOpacity?: number;
  fillColor?: string;
  fillOpacity?: number;
  /** Google draws no dashes natively; see the note above. */
  dashed?: boolean;
  dashRepeat?: string;
  zIndex?: number;
  /** Point geometries are drawn as circular markers with these settings. */
  point?: {
    radius: number;
    fillColor: string;
    fillOpacity?: number;
    strokeColor?: string;
    strokeWeight?: number;
  };
}

export type FeatureClick = (
  properties: Record<string, unknown>,
  latLng: google.maps.LatLng | null
) => void;

/** GeoJSON is `[lon, lat]`; Google is `{lat, lng}`. */
export function toPath(ring: GeoJSON.Position[]): google.maps.LatLngLiteral[] {
  return ring.map(([lon, lat]) => ({ lat, lng: lon }));
}

function dashIcons(
  colour: string,
  opacity: number,
  weight: number,
  repeat: string
): google.maps.IconSequence[] {
  return [
    {
      icon: {
        path: 'M 0,-1 0,1',
        strokeColor: colour,
        strokeOpacity: opacity,
        strokeWeight: weight,
        scale: Math.max(1.5, weight * 1.4)
      },
      offset: '0',
      repeat
    }
  ];
}

function line(
  maps: typeof google.maps,
  path: google.maps.LatLngLiteral[],
  style: GeoStyle,
  clickable: boolean
): google.maps.Polyline {
  const colour = style.strokeColor ?? '#ffffff';
  const weight = style.strokeWeight ?? 1;
  const opacity = style.strokeOpacity ?? 1;
  return new maps.Polyline({
    path,
    strokeColor: colour,
    strokeWeight: weight,
    strokeOpacity: style.dashed ? 0 : opacity,
    icons: style.dashed ? dashIcons(colour, opacity, weight, style.dashRepeat ?? '10px') : undefined,
    zIndex: style.zIndex,
    clickable
  });
}

function pushGeometry(
  maps: typeof google.maps,
  geometry: GeoJSON.Geometry | null,
  style: GeoStyle,
  properties: Record<string, unknown>,
  onClick: FeatureClick | undefined,
  out: google.maps.MapOverlay[]
) {
  if (!geometry) return;
  const clickable = Boolean(onClick);
  const bind = (overlay: google.maps.Polyline | google.maps.Polygon | google.maps.Marker) => {
    if (onClick) overlay.addListener('click', (e) => onClick(properties, e.latLng));
    out.push(overlay);
  };

  switch (geometry.type) {
    case 'Point': {
      const spec = style.point;
      if (!spec) return;
      const [lon, lat] = geometry.coordinates;
      bind(
        new maps.Marker({
          position: { lat, lng: lon },
          icon: {
            path: maps.SymbolPath.CIRCLE,
            scale: spec.radius,
            fillColor: spec.fillColor,
            fillOpacity: spec.fillOpacity ?? 1,
            strokeColor: spec.strokeColor ?? spec.fillColor,
            strokeWeight: spec.strokeWeight ?? 1
          },
          zIndex: style.zIndex,
          clickable,
          cursor: clickable ? 'pointer' : undefined,
          optimized: false
        })
      );
      return;
    }
    case 'MultiPoint':
      for (const position of geometry.coordinates) {
        pushGeometry(maps, { type: 'Point', coordinates: position }, style, properties, onClick, out);
      }
      return;
    case 'LineString':
      bind(line(maps, toPath(geometry.coordinates), style, clickable));
      return;
    case 'MultiLineString':
      for (const part of geometry.coordinates) bind(line(maps, toPath(part), style, clickable));
      return;
    case 'Polygon':
    case 'MultiPolygon': {
      const polygons: GeoJSON.Position[][][] =
        geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      for (const rings of polygons) {
        bind(
          new maps.Polygon({
            paths: rings.map(toPath),
            fillColor: style.fillColor ?? 'transparent',
            fillOpacity: style.fillColor ? (style.fillOpacity ?? 0.2) : 0,
            strokeColor: style.strokeColor ?? '#ffffff',
            strokeWeight: style.strokeColor && !style.dashed ? (style.strokeWeight ?? 1) : 0,
            strokeOpacity: style.strokeColor && !style.dashed ? (style.strokeOpacity ?? 1) : 0,
            zIndex: style.zIndex,
            clickable
          })
        );
        // A dashed outline cannot live on the polygon, so it is its own line.
        if (style.dashed && style.strokeColor) {
          for (const ring of rings) out.push(line(maps, toPath(ring), style, false));
        }
      }
      return;
    }
    case 'GeometryCollection':
      for (const part of geometry.geometries) {
        pushGeometry(maps, part, style, properties, onClick, out);
      }
      return;
    default:
  }
}

/** Turn a feature collection into overlays. They are created detached. */
export function overlaysFromGeoJson(
  maps: typeof google.maps,
  data: GeoJSON.FeatureCollection | undefined,
  style: GeoStyle,
  onClick?: FeatureClick
): google.maps.MapOverlay[] {
  const out: google.maps.MapOverlay[] = [];
  for (const feature of data?.features ?? []) {
    pushGeometry(
      maps,
      feature.geometry,
      style,
      (feature.properties ?? {}) as Record<string, unknown>,
      onClick,
      out
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconciling overlays across updates
// ---------------------------------------------------------------------------
//
// The primary chart moves a vessel by handing MapLibre new GeoJSON for a source
// it already has. Google has no equivalent, and the obvious translation -
// discard the overlays and build new ones each time a position arrives - makes
// the vessel visibly shake: it is removed and redrawn several times a second,
// and the eye reads that as a marker vibrating rather than a marker moving.
//
// So overlays are reconciled instead of replaced. An existing marker is moved,
// a polyline is given a new path, and only a change in the number of them
// creates or retires anything. Each marker also carries a signature of
// everything that affects how it draws, so an unchanged marker is left
// completely alone rather than being re-set to its current value.

export interface MarkerSpec {
  signature: string;
  options: google.maps.MarkerOptions;
}

/** Pair marker options with a signature of how they draw. */
export function markerSpec(options: google.maps.MarkerOptions): MarkerSpec {
  const position = options.position as google.maps.LatLngLiteral;
  const icon = options.icon as google.maps.Symbol | undefined;
  return {
    signature: [
      position.lat.toFixed(7),
      position.lng.toFixed(7),
      icon?.path,
      icon?.scale,
      // Heading noise below a tenth of a degree is not a visible rotation, and
      // redrawing for it is exactly the flicker this avoids.
      icon?.rotation?.toFixed(1),
      icon?.fillColor,
      icon?.fillOpacity,
      icon?.strokeColor,
      icon?.strokeWeight,
      icon?.strokeOpacity,
      options.title,
      options.zIndex
    ].join('|'),
    options
  };
}

/**
 * Bring `pool` into line with `specs`, reusing markers where it can.
 *
 * `pool` and `signatures` are mutated in place; `onCreate` is called only for a
 * marker that had to be built, which is where a listener belongs - reattaching
 * one on every update would accumulate handlers on a marker that never moved.
 */
export function syncMarkers(
  maps: typeof google.maps,
  pool: google.maps.Marker[],
  signatures: string[],
  specs: MarkerSpec[],
  map: google.maps.Map | null,
  onCreate?: (marker: google.maps.Marker, index: number) => void
): void {
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const existing = pool[i];
    if (!existing) {
      const marker = new maps.Marker({ ...spec.options, map, optimized: false });
      pool[i] = marker;
      signatures[i] = spec.signature;
      onCreate?.(marker, i);
      continue;
    }
    if (signatures[i] !== spec.signature) {
      existing.setOptions(spec.options);
      signatures[i] = spec.signature;
    }
    // A no-op when the value is unchanged, so this costs nothing per update.
    existing.setMap(map);
  }
  for (let i = specs.length; i < pool.length; i += 1) {
    pool[i].setMap(null);
    maps.event.clearInstanceListeners(pool[i]);
  }
  pool.length = specs.length;
  signatures.length = specs.length;
}

export type PathSpec =
  | { kind: 'line'; options: google.maps.PolylineOptions }
  | { kind: 'polygon'; options: google.maps.PolygonOptions };

/**
 * The same reconciliation for lines and polygons.
 *
 * `kinds` records what occupies each slot, because a line cannot be reused as a
 * polygon; a slot whose kind has changed is rebuilt.
 */
export function syncPaths(
  maps: typeof google.maps,
  pool: google.maps.MapOverlay[],
  kinds: string[],
  specs: PathSpec[],
  map: google.maps.Map | null
): void {
  const build = (spec: PathSpec): google.maps.MapOverlay =>
    spec.kind === 'line'
      ? new maps.Polyline({ ...spec.options, map })
      : new maps.Polygon({ ...spec.options, map });

  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const existing = pool[i];
    if (!existing || kinds[i] !== spec.kind) {
      if (existing) {
        existing.setMap(null);
        maps.event.clearInstanceListeners(existing);
      }
      pool[i] = build(spec);
      kinds[i] = spec.kind;
      continue;
    }
    if (spec.kind === 'line') (existing as google.maps.Polyline).setOptions(spec.options);
    else (existing as google.maps.Polygon).setOptions(spec.options);
    existing.setMap(map);
  }
  for (let i = specs.length; i < pool.length; i += 1) {
    pool[i].setMap(null);
    maps.event.clearInstanceListeners(pool[i]);
  }
  pool.length = specs.length;
  kinds.length = specs.length;
}

/** The ring of a generated polygon, as a Google path. */
export function ringOf(polygon: GeoJSON.Polygon): google.maps.LatLngLiteral[] {
  return toPath(polygon.coordinates[0] ?? []);
}

/** Dash icons for a polyline, matching the primary chart's dashed strokes. */
export function dashedStroke(colour: string, opacity: number, weight: number, repeat: string) {
  return dashIcons(colour, opacity, weight, repeat);
}

/** The popup body used for reference features, matching the primary chart. */
export function featureInfoHtml(properties: Record<string, unknown>, labelColour: string): string {
  const rows = Object.entries(properties)
    .filter(([key]) => key !== 'demonstration_only')
    .map(
      ([key, value]) =>
        `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:${labelColour}">${key.replace(
          /_/g,
          ' '
        )}</span><span style="font-family:monospace">${String(value)}</span></div>`
    )
    .join('');
  return `<div style="padding:2px 4px;font-size:12px;line-height:1.5;color:#111">${rows}</div>`;
}
