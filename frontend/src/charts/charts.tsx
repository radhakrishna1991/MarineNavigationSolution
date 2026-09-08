/**
 * Chart components.
 *
 * The specification asks for separate charts rather than one crowded combined
 * chart, so each of these does one job. A shared theme keeps them legible on a
 * dark bridge display: thin axes, no gridline clutter, tabular figures, and a
 * colour per series that matches the map's colour for the same source.
 */

import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { SOURCE_COLOURS } from '../utils/status';
import { EmptyState } from '../components/ui';

const AXIS_COLOUR = '#3b5178';
const TEXT_COLOUR = '#8ba1c4';
const GRID_COLOUR = '#18243c';

/** Shared axis and grid styling. */
function baseOption(overrides: EChartsOption = {}): EChartsOption {
  return {
    backgroundColor: 'transparent',
    animation: false,
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: TEXT_COLOUR, fontSize: 11 },
    grid: { left: 52, right: 18, top: 28, bottom: 32, containLabel: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#0e1626',
      borderColor: '#2a3c5e',
      borderWidth: 1,
      textStyle: { color: '#dde6f2', fontSize: 11 },
      axisPointer: { type: 'line', lineStyle: { color: '#5a739c', type: 'dashed' } }
    },
    ...overrides
  };
}

function timeAxis(name = 'Scenario time (s)') {
  return {
    type: 'value' as const,
    name,
    nameLocation: 'middle' as const,
    nameGap: 22,
    nameTextStyle: { color: TEXT_COLOUR, fontSize: 10 },
    axisLine: { lineStyle: { color: AXIS_COLOUR } },
    axisTick: { lineStyle: { color: AXIS_COLOUR } },
    axisLabel: { color: TEXT_COLOUR, fontSize: 10 },
    splitLine: { show: false }
  };
}

function valueAxis(name: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'value' as const,
    name,
    nameTextStyle: { color: TEXT_COLOUR, fontSize: 10, align: 'left' as const },
    nameGap: 12,
    axisLine: { lineStyle: { color: AXIS_COLOUR } },
    axisTick: { show: false },
    axisLabel: { color: TEXT_COLOUR, fontSize: 10 },
    splitLine: { lineStyle: { color: GRID_COLOUR } },
    ...extra
  };
}

export interface SeriesPoint {
  t: number;
  value: number | null;
}

function Chart({ option, height = 220 }: { option: EChartsOption; height?: number }) {
  return (
    <ReactECharts
      option={option}
      style={{ height, width: '100%' }}
      opts={{ renderer: 'canvas' }}
      notMerge
      lazyUpdate
    />
  );
}

/**
 * Error vs protection level.
 *
 * The single most informative chart in the platform: it shows whether the bound
 * the system publishes actually contains the error it is bounding.
 */
export function ErrorVsProtectionChart({
  data,
  limit,
  height = 240,
  showActual = true
}: {
  data: Array<{ t: number; actual: number | null; estimated: number | null; hpl: number | null }>;
  limit: number;
  height?: number;
  showActual?: boolean;
}) {
  const option = useMemo<EChartsOption>(
    () =>
      baseOption({
        legend: {
          top: 0,
          right: 0,
          textStyle: { color: TEXT_COLOUR, fontSize: 10 },
          itemWidth: 14,
          itemHeight: 8,
          icon: 'roundRect'
        },
        xAxis: timeAxis(),
        yAxis: valueAxis('metres', { min: 0 }),
        series: [
          {
            name: 'Protection level (bound)',
            type: 'line',
            showSymbol: false,
            data: data.map((d) => [d.t, d.hpl]),
            lineStyle: { color: '#f0b429', width: 2 },
            itemStyle: { color: '#f0b429' },
            areaStyle: { color: 'rgba(240,180,41,0.10)' }
          },
          {
            name: 'Estimated error',
            type: 'line',
            showSymbol: false,
            data: data.map((d) => [d.t, d.estimated]),
            lineStyle: { color: '#38bdf8', width: 1.4, type: 'dashed' },
            itemStyle: { color: '#38bdf8' }
          },
          ...(showActual
            ? [
                {
                  name: 'Actual error vs ground truth',
                  type: 'line' as const,
                  showSymbol: false,
                  data: data.map((d) => [d.t, d.actual]),
                  lineStyle: { color: SOURCE_COLOURS.fused, width: 1.8 },
                  itemStyle: { color: SOURCE_COLOURS.fused }
                }
              ]
            : []),
          {
            name: `${limit} m requirement`,
            type: 'line',
            showSymbol: false,
            data: [],
            markLine: {
              silent: true,
              symbol: 'none',
              label: { formatter: `${limit} m limit`, color: '#12b981', fontSize: 10, position: 'insideEndTop' },
              lineStyle: { color: '#12b981', type: 'dashed', width: 1.5 },
              data: [{ yAxis: limit }]
            }
          }
        ]
      }),
    [data, limit, showActual]
  );

  if (data.length === 0) {
    return <EmptyState title="No error data yet" detail="Start a scenario to begin recording." icon="◫" />;
  }
  return <Chart option={option} height={height} />;
}

/** GNSS trust score over time, with the decision bands shaded. */
export function TrustScoreChart({
  data,
  height = 200
}: {
  data: Array<{ t: number; trust: number | null }>;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(
    () =>
      baseOption({
        xAxis: timeAxis(),
        yAxis: valueAxis('trust score', { min: 0, max: 100 }),
        series: [
          {
            name: 'GNSS trust',
            type: 'line',
            showSymbol: false,
            data: data.map((d) => [d.t, d.trust]),
            lineStyle: { color: '#38bdf8', width: 2 },
            itemStyle: { color: '#38bdf8' },
            markArea: {
              silent: true,
              itemStyle: { opacity: 0.12 },
              data: [
                [{ yAxis: 0, itemStyle: { color: '#ef3f5b' } }, { yAxis: 20 }],
                [{ yAxis: 20, itemStyle: { color: '#f2683c' } }, { yAxis: 50 }],
                [{ yAxis: 50, itemStyle: { color: '#f0b429' } }, { yAxis: 75 }],
                [{ yAxis: 75, itemStyle: { color: '#12b981' } }, { yAxis: 100 }]
              ]
            }
          }
        ]
      }),
    [data]
  );

  if (data.length === 0) return <EmptyState title="No GNSS trust history yet" icon="◈" />;
  return <Chart option={option} height={height} />;
}

/** Navigation mode timeline as a stepped categorical band. */
export function ModeTimelineChart({
  data,
  height = 200
}: {
  data: Array<{ t: number; mode: string }>;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(() => {
    const modes = [...new Set(data.map((d) => d.mode))];
    const modeIndex = new Map(modes.map((m, i) => [m, i]));
    const tone: Record<string, string> = {
      NORMAL_GNSS: '#12b981',
      GNSS_DEGRADED: '#f0b429',
      SPOOFING_SUSPECTED: '#ef3f5b',
      JAMMING_SUSPECTED: '#f2683c',
      GNSS_REJECTED: '#f0b429',
      RADAR_AIDED_NAVIGATION: '#38bdf8',
      LIDAR_AIDED_NAVIGATION: '#a78bfa',
      BATHYMETRIC_AIDED_NAVIGATION: '#22d3ee',
      DEAD_RECKONING: '#f97316',
      INS_AIDED_NAVIGATION: '#f97316',
      LOCAL_POSITIONING_MODE: '#84cc16',
      MANUAL_FALLBACK: '#ef3f5b',
      GNSS_RECOVERY_VALIDATION: '#38bdf8',
      INTEGRITY_NOT_ASSURED: '#ef3f5b'
    };
    return baseOption({
      grid: { left: 190, right: 18, top: 12, bottom: 32 },
      xAxis: timeAxis(),
      yAxis: {
        type: 'category',
        data: modes.map((m) => m.replace(/_/g, ' ')),
        axisLine: { lineStyle: { color: AXIS_COLOUR } },
        axisTick: { show: false },
        axisLabel: { color: TEXT_COLOUR, fontSize: 10 },
        splitLine: { show: false }
      },
      tooltip: {
        trigger: 'item',
        backgroundColor: '#0e1626',
        borderColor: '#2a3c5e',
        textStyle: { color: '#dde6f2', fontSize: 11 },
        formatter: (p: any) => `${p.value[0].toFixed(1)} s<br/>${modes[p.value[1]]?.replace(/_/g, ' ')}`
      },
      series: [
        {
          type: 'scatter',
          symbolSize: 5,
          data: data.map((d) => ({
            value: [d.t, modeIndex.get(d.mode) ?? 0],
            itemStyle: { color: tone[d.mode] ?? '#8ba1c4' }
          }))
        }
      ]
    });
  }, [data]);

  if (data.length === 0) return <EmptyState title="No mode history yet" icon="⬡" />;
  return <Chart option={option} height={height} />;
}

/** Requirement compliance over time as a coloured band. */
export function RequirementTimelineChart({
  data,
  height = 110
}: {
  data: Array<{ t: number; requirement: string }>;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(() => {
    const colour: Record<string, string> = {
      REQUIREMENT_MET: '#12b981',
      REQUIREMENT_AT_RISK: '#f0b429',
      REQUIREMENT_NOT_MET: '#ef3f5b',
      INSUFFICIENT_INFORMATION: '#8ba1c4'
    };
    return baseOption({
      grid: { left: 52, right: 18, top: 10, bottom: 32 },
      xAxis: timeAxis(),
      yAxis: { type: 'value', min: 0, max: 1, show: false },
      tooltip: {
        trigger: 'item',
        backgroundColor: '#0e1626',
        borderColor: '#2a3c5e',
        textStyle: { color: '#dde6f2', fontSize: 11 },
        formatter: (p: any) => `${p.value[0].toFixed(1)} s<br/>${p.data.status.replace(/_/g, ' ')}`
      },
      series: [
        {
          type: 'bar',
          barWidth: '100%',
          data: data.map((d) => ({
            value: [d.t, 1],
            status: d.requirement,
            itemStyle: { color: colour[d.requirement] ?? '#8ba1c4' }
          }))
        }
      ]
    });
  }, [data]);

  if (data.length === 0) return <EmptyState title="No compliance history yet" icon="◫" />;
  return <Chart option={option} height={height} />;
}

/** Generic single-series line chart. */
export function LineChart({
  data,
  label,
  unit,
  colour = '#38bdf8',
  height = 180,
  markLineAt,
  markLineLabel
}: {
  data: SeriesPoint[];
  label: string;
  unit?: string;
  colour?: string;
  height?: number;
  markLineAt?: number;
  markLineLabel?: string;
}) {
  const option = useMemo<EChartsOption>(
    () =>
      baseOption({
        xAxis: timeAxis(),
        yAxis: valueAxis(unit ?? ''),
        series: [
          {
            name: label,
            type: 'line',
            showSymbol: false,
            data: data.map((d) => [d.t, d.value]),
            lineStyle: { color: colour, width: 1.8 },
            itemStyle: { color: colour },
            areaStyle: { color: `${colour}18` },
            ...(markLineAt !== undefined
              ? {
                  markLine: {
                    silent: true,
                    symbol: 'none',
                    label: { formatter: markLineLabel ?? String(markLineAt), color: '#f0b429', fontSize: 10 },
                    lineStyle: { color: '#f0b429', type: 'dashed' },
                    data: [{ yAxis: markLineAt }]
                  }
                }
              : {})
          }
        ]
      }),
    [data, label, unit, colour, markLineAt, markLineLabel]
  );

  if (data.length === 0) return <EmptyState title={`No ${label.toLowerCase()} data yet`} icon="◫" />;
  return <Chart option={option} height={height} />;
}

/** Horizontal bar chart, used for sensor availability and mode durations. */
export function BarChart({
  data,
  unit,
  height = 240,
  colour = '#38bdf8',
  max
}: {
  data: Array<{ label: string; value: number; colour?: string }>;
  unit?: string;
  height?: number;
  colour?: string;
  max?: number;
}) {
  const option = useMemo<EChartsOption>(
    () =>
      baseOption({
        grid: { left: 170, right: 40, top: 10, bottom: 28 },
        xAxis: valueAxis(unit ?? '', { max }),
        yAxis: {
          type: 'category',
          data: data.map((d) => d.label),
          axisLine: { lineStyle: { color: AXIS_COLOUR } },
          axisTick: { show: false },
          axisLabel: { color: TEXT_COLOUR, fontSize: 10 }
        },
        series: [
          {
            type: 'bar',
            data: data.map((d) => ({ value: d.value, itemStyle: { color: d.colour ?? colour, borderRadius: [0, 3, 3, 0] } })),
            barMaxWidth: 16,
            label: {
              show: true,
              position: 'right',
              color: TEXT_COLOUR,
              fontSize: 10,
              formatter: (p: any) => `${Number(p.value).toFixed(1)}${unit ? ` ${unit}` : ''}`
            }
          }
        ]
      }),
    [data, unit, colour, max]
  );

  if (data.length === 0) return <EmptyState title="No data" icon="◫" />;
  return <Chart option={option} height={height} />;
}

/** Error distribution histogram with percentile markers. */
export function ErrorDistributionChart({
  values,
  limit,
  height = 200
}: {
  values: number[];
  limit: number;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(() => {
    if (values.length === 0) return baseOption({});
    const max = Math.max(...values, limit * 1.2);
    const bins = 30;
    const width = max / bins;
    const counts = new Array(bins).fill(0);
    for (const v of values) {
      const i = Math.min(bins - 1, Math.floor(v / width));
      counts[i] += 1;
    }
    return baseOption({
      grid: { left: 52, right: 18, top: 16, bottom: 34 },
      xAxis: {
        type: 'category',
        data: counts.map((_, i) => ((i + 0.5) * width).toFixed(2)),
        name: 'error (m)',
        nameLocation: 'middle',
        nameGap: 22,
        nameTextStyle: { color: TEXT_COLOUR, fontSize: 10 },
        axisLine: { lineStyle: { color: AXIS_COLOUR } },
        axisLabel: { color: TEXT_COLOUR, fontSize: 9, interval: 3 }
      },
      yAxis: valueAxis('epochs'),
      series: [
        {
          type: 'bar',
          data: counts.map((c, i) => ({
            value: c,
            itemStyle: { color: (i + 0.5) * width > limit ? '#ef3f5b' : '#12b981', opacity: 0.8 }
          })),
          barCategoryGap: '10%'
        }
      ]
    });
  }, [values, limit]);

  if (values.length === 0) return <EmptyState title="No error samples" icon="◫" />;
  return <Chart option={option} height={height} />;
}

/** Compact sparkline for tiles. */
export function Sparkline({
  data,
  colour = '#38bdf8',
  height = 40,
  limit
}: {
  data: Array<number | null>;
  colour?: string;
  height?: number;
  limit?: number;
}) {
  const option = useMemo<EChartsOption>(
    () => ({
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 0, right: 0, top: 2, bottom: 2 },
      xAxis: { type: 'category', show: false, data: data.map((_, i) => i) },
      yAxis: { type: 'value', show: false, scale: true },
      tooltip: { show: false },
      series: [
        {
          type: 'line',
          data,
          showSymbol: false,
          lineStyle: { color: colour, width: 1.5 },
          areaStyle: { color: `${colour}22` },
          ...(limit !== undefined
            ? {
                markLine: {
                  silent: true,
                  symbol: 'none',
                  label: { show: false },
                  lineStyle: { color: '#f0b429', type: 'dashed', width: 1 },
                  data: [{ yAxis: limit }]
                }
              }
            : {})
        }
      ]
    }),
    [data, colour, limit]
  );

  if (data.length < 2) return <div style={{ height }} />;
  return <ReactECharts option={option} style={{ height, width: '100%' }} opts={{ renderer: 'canvas' }} notMerge />;
}

/** Scatter of C/N0 and satellite count, for the GNSS panel. */
export function SignalQualityChart({
  data,
  height = 180
}: {
  data: Array<{ t: number; cn0: number | null; satellites: number | null; hdop: number | null }>;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(
    () =>
      baseOption({
        legend: { top: 0, right: 0, textStyle: { color: TEXT_COLOUR, fontSize: 10 }, itemWidth: 14, itemHeight: 8 },
        grid: { left: 44, right: 44, top: 28, bottom: 32 },
        xAxis: timeAxis(),
        yAxis: [
          valueAxis('C/N0 dB-Hz', { min: 0, max: 55 }),
          valueAxis('satellites / HDOP', { min: 0, position: 'right', splitLine: { show: false } })
        ],
        series: [
          {
            name: 'C/N0 (dB-Hz)',
            type: 'line',
            showSymbol: false,
            yAxisIndex: 0,
            data: data.map((d) => [d.t, d.cn0]),
            lineStyle: { color: '#38bdf8', width: 1.8 },
            itemStyle: { color: '#38bdf8' }
          },
          {
            name: 'Satellites',
            type: 'line',
            showSymbol: false,
            yAxisIndex: 1,
            data: data.map((d) => [d.t, d.satellites]),
            lineStyle: { color: '#12b981', width: 1.5 },
            itemStyle: { color: '#12b981' }
          },
          {
            name: 'HDOP',
            type: 'line',
            showSymbol: false,
            yAxisIndex: 1,
            data: data.map((d) => [d.t, d.hdop]),
            lineStyle: { color: '#f0b429', width: 1.3, type: 'dashed' },
            itemStyle: { color: '#f0b429' }
          }
        ]
      }),
    [data]
  );

  if (data.length === 0) return <EmptyState title="No GNSS signal history yet" icon="◈" />;
  return <Chart option={option} height={height} />;
}
