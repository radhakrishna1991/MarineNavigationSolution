/**
 * Minimal ambient declarations for the Google Maps JavaScript API.
 *
 * The full `@types/google.maps` package is not a dependency: the platform must
 * install and build on an isolated network, and adding a package purely for
 * types would break that for a feature that is optional at runtime. This
 * declares only the surface the Google chart actually uses, which keeps the
 * type checker honest without the dependency.
 *
 * Anything added to the Google chart that is not declared here will fail to
 * compile - that is deliberate. Extend this file rather than casting to `any`.
 */

declare namespace google.maps {
  interface LatLngLiteral {
    lat: number;
    lng: number;
  }

  class LatLng {
    constructor(lat: number, lng: number);
    lat(): number;
    lng(): number;
  }

  interface LatLngBoundsLiteral {
    north: number;
    south: number;
    east: number;
    west: number;
  }

  class LatLngBounds {
    constructor(sw?: LatLng | LatLngLiteral, ne?: LatLng | LatLngLiteral);
    extend(point: LatLng | LatLngLiteral): LatLngBounds;
    isEmpty(): boolean;
  }

  class Point {
    constructor(x: number, y: number);
  }

  interface Padding {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  }

  interface MapsEventListener {
    remove(): void;
  }

  interface MapMouseEvent {
    latLng: LatLng | null;
    domEvent?: Event;
  }

  type MapTypeId = 'roadmap' | 'satellite' | 'hybrid' | 'terrain';

  const ControlPosition: {
    TOP_LEFT: number;
    TOP_CENTER: number;
    TOP_RIGHT: number;
    LEFT_TOP: number;
    RIGHT_TOP: number;
    LEFT_CENTER: number;
    RIGHT_CENTER: number;
    LEFT_BOTTOM: number;
    RIGHT_BOTTOM: number;
    BOTTOM_LEFT: number;
    BOTTOM_CENTER: number;
    BOTTOM_RIGHT: number;
  };

  interface MapTypeStyle {
    featureType?: string;
    elementType?: string;
    stylers: Array<Record<string, string | number | boolean>>;
  }

  interface MapOptions {
    center?: LatLng | LatLngLiteral;
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
    mapTypeId?: MapTypeId;
    mapTypeControl?: boolean;
    mapTypeControlOptions?: { style?: number; position?: number; mapTypeIds?: MapTypeId[] };
    streetViewControl?: boolean;
    fullscreenControl?: boolean;
    rotateControl?: boolean;
    scaleControl?: boolean;
    zoomControl?: boolean;
    zoomControlOptions?: { position?: number };
    clickableIcons?: boolean;
    keyboardShortcuts?: boolean;
    tilt?: number;
    gestureHandling?: 'cooperative' | 'greedy' | 'none' | 'auto';
    backgroundColor?: string;
    styles?: MapTypeStyle[];
    disableDefaultUI?: boolean;
  }

  class Map {
    constructor(element: HTMLElement, options?: MapOptions);
    setOptions(options: MapOptions): void;
    setCenter(latLng: LatLng | LatLngLiteral): void;
    panTo(latLng: LatLng | LatLngLiteral): void;
    setZoom(zoom: number): void;
    getZoom(): number | undefined;
    fitBounds(bounds: LatLngBounds | LatLngBoundsLiteral, padding?: number | Padding): void;
    addListener(eventName: string, handler: (event: MapMouseEvent) => void): MapsEventListener;
    setMapTypeId(mapTypeId: MapTypeId): void;
  }

  /** Anything that can be attached to, or detached from, a map. */
  interface MapOverlay {
    setMap(map: Map | null): void;
  }

  interface Icon {
    url: string;
    scaledSize?: Size;
    anchor?: Point;
  }

  class Size {
    constructor(width: number, height: number);
  }

  const SymbolPath: {
    CIRCLE: number;
    FORWARD_CLOSED_ARROW: number;
    FORWARD_OPEN_ARROW: number;
  };

  interface Symbol {
    path: string | number;
    scale?: number;
    rotation?: number;
    fillColor?: string;
    fillOpacity?: number;
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWeight?: number;
    anchor?: Point;
  }

  interface IconSequence {
    icon: Symbol;
    offset?: string;
    repeat?: string;
  }

  interface MarkerOptions {
    position: LatLng | LatLngLiteral;
    map?: Map | null;
    icon?: Symbol | Icon;
    title?: string;
    zIndex?: number;
    clickable?: boolean;
    cursor?: string;
    optimized?: boolean;
  }

  class Marker implements MapOverlay {
    constructor(options?: MarkerOptions);
    setMap(map: Map | null): void;
    setOptions(options: Partial<MarkerOptions>): void;
    setPosition(position: LatLng | LatLngLiteral): void;
    getPosition(): LatLng | null | undefined;
    addListener(eventName: string, handler: (event: MapMouseEvent) => void): MapsEventListener;
  }

  interface PolylineOptions {
    path?: Array<LatLng | LatLngLiteral>;
    map?: Map | null;
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWeight?: number;
    icons?: IconSequence[];
    zIndex?: number;
    clickable?: boolean;
    geodesic?: boolean;
  }

  class Polyline implements MapOverlay {
    constructor(options?: PolylineOptions);
    setMap(map: Map | null): void;
    setOptions(options: PolylineOptions): void;
    addListener(eventName: string, handler: (event: MapMouseEvent) => void): MapsEventListener;
  }

  interface PolygonOptions {
    paths?: Array<Array<LatLng | LatLngLiteral>> | Array<LatLng | LatLngLiteral>;
    map?: Map | null;
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWeight?: number;
    fillColor?: string;
    fillOpacity?: number;
    zIndex?: number;
    clickable?: boolean;
  }

  class Polygon implements MapOverlay {
    constructor(options?: PolygonOptions);
    setMap(map: Map | null): void;
    setOptions(options: PolygonOptions): void;
    addListener(eventName: string, handler: (event: MapMouseEvent) => void): MapsEventListener;
  }

  interface GroundOverlayOptions {
    opacity?: number;
    clickable?: boolean;
    map?: Map | null;
  }

  class GroundOverlay implements MapOverlay {
    constructor(url: string, bounds: LatLngBoundsLiteral | LatLngBounds, options?: GroundOverlayOptions);
    setMap(map: Map | null): void;
    setOpacity(opacity: number): void;
  }

  interface InfoWindowOptions {
    content?: string | HTMLElement;
    position?: LatLng | LatLngLiteral;
    maxWidth?: number;
    disableAutoPan?: boolean;
  }

  class InfoWindow {
    constructor(options?: InfoWindowOptions);
    open(options?: { map?: Map; anchor?: Marker }): void;
    close(): void;
    setContent(content: string | HTMLElement): void;
    setPosition(position: LatLng | LatLngLiteral): void;
  }

  namespace event {
    function clearInstanceListeners(instance: object): void;
  }
}

interface Window {
  google?: typeof google;
}
