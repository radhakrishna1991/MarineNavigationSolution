import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// MapLibre needs WebGL and a real canvas; neither exists in jsdom. The map is
// exercised separately in the browser, so here it is replaced with a stub that
// records the props it was given.
vi.mock('maplibre-gl', () => {
  class MockMap {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers: Record<string, any[]> = {};
    on(event: string, a?: unknown, b?: unknown) {
      const handler = typeof a === 'function' ? a : b;
      this.handlers[event] = this.handlers[event] ?? [];
      if (typeof handler === 'function') this.handlers[event].push(handler);
      if (event === 'load') setTimeout(() => (handler as () => void)?.(), 0);
      return this;
    }
    addControl() {
      return this;
    }
    addSource() {
      return this;
    }
    addLayer() {
      return this;
    }
    getSource() {
      return undefined;
    }
    getLayer() {
      return undefined;
    }
    setLayoutProperty() {}
    hasImage() {
      return true;
    }
    addImage() {}
    easeTo() {}
    remove() {}
    getCanvas() {
      return { style: {} };
    }
  }
  return {
    default: {
      Map: MockMap,
      NavigationControl: class {},
      ScaleControl: class {},
      AttributionControl: class {},
      Popup: class {
        setLngLat() {
          return this;
        }
        setHTML() {
          return this;
        }
        addTo() {
          return this;
        }
      }
    },
    Map: MockMap
  };
});

// ECharts renders to canvas, which jsdom does not implement. The stub records
// how many series it was handed so tests can still assert a chart was built.
vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  return {
    default: ({ option }: { option: { series?: unknown[] } }) =>
      React.createElement('div', {
        'data-testid': 'chart',
        'data-series-count': String(option?.series?.length ?? 0)
      })
  };
});

/**
 * jsdom supplies its own AbortController, but Node's global `Request` comes
 * from undici and brand-checks the signal against *Node's* AbortSignal. The two
 * do not match, so `new Request(url, { signal })` throws before any test stub
 * is consulted. A minimal Request shim sidesteps the clash; it only has to
 * satisfy what RTK Query actually uses, since no real network I/O happens here.
 * Browsers have one consistent implementation and need none of this.
 */
class TestRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  signal: unknown;

  constructor(input: string | { url: string }, init: Record<string, any> = {}) {
    this.url = typeof input === 'string' ? input : input.url;
    this.method = (init.method ?? 'GET').toUpperCase();
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers ?? {});
    this.body = init.body;
    this.signal = init.signal;
  }

  clone() {
    return new TestRequest(this.url, {
      method: this.method,
      headers: this.headers,
      body: this.body,
      signal: this.signal
    });
  }

  async text() {
    return typeof this.body === 'string' ? this.body : '';
  }
}
global.Request = TestRequest as unknown as typeof Request;

// jsdom has no ResizeObserver, which several layout-aware components expect.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Nor URL.createObjectURL, used by the export helper.
if (!global.URL.createObjectURL) {
  global.URL.createObjectURL = () => 'blob:mock';
  global.URL.revokeObjectURL = () => {};
}
