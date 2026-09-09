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
import { sourceColours } from '../utils/status';
import { EmptyState } from '../components/ui';
import { themeColor, themeHex, type ThemeToken } from '../theme/theme';
import { useResolvedTheme } from '../theme/useTheme';

/*
 * ECharts takes colour literals, so the charts cannot inherit the palette
 * through CSS the way the rest of the interface does. These read the same
 * custom properties at the moment an option object is built, and every chart
 * lists the resolved theme in its `useMemo` dependencies so the options are
 * rebuilt when the palette changes.
 */
const axisColour = () => themeColor('chart-axis');
const textColour = () => themeColor('chart-text');
const gridColour = () => themeColor('chart-grid');

/** Shared axis and grid styling. */
function baseOption(overrides: EChartsOption = {}): EChartsOption {
  return {
    backgroundColor: 'transparent',
    animation: false,
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: textColour(), fontSize: 11 },
    grid: { left: 52, right: 18, top: 28, bottom: 32, containLabel: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: themeColor('chart-tooltip-bg'),
      borderColor: themeColor('chart-tooltip-border'),
      borderWidth: 1,
      textStyle: { color: themeColor('chart-tooltip-text'), fontSize: 11 },
      axisPointer: { type: 'line', lineStyle: { color: themeColor('chart-pointer'), type: 'dashed' } }
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
    nameTextStyle: { color: textColour(), fontSize: 10 },
    axisLine: { lineStyle: { color: axisColour() } },
    axisTick: { lineStyle: { color: axisColour() } },
    axisLabel: { color: textColour(), fontSize: 10 },
    splitLine: { show: false }
  };
}

function valueAxis(name: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'value' as const,
    name,
    nameTextStyle: { color: textColour(), fontSize: 10, align: 'left' as const },
    nameGap: 12,
    axisLine: { lineStyle: { color: axisColour() } },
    axisTick: { show: false },
    axisLabel: { color: textColour(), fontSize: 10 },
    splitLine: { lineStyle: { color: gridColour() } },
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
  const theme = useResolvedTheme();
  const option = useMemo<EChartsOption>(
    () =>
      baseOption({
        legend: {
          top: 0,
          right: 0,
          textStyle: { color: textColour(), fontSize: 10 },
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
            lineStyle: { color: themeColor('caution'), width: 2 },
            itemStyle: { color: themeColor('caution') },
            areaStyle: { color: 'rgba(240,180,41,0.10)' }
          },
          {
            name: 'Estimated error',
            type: 'line',
            showSymbol: false,
            data: data.map((d) => [d.t, d.estimated]),
            lineStyle: { color: themeColor('chart-series-a'), width: 1.4, type: 'dashed' },
            itemStyle: { color: themeColor('chart-series-a') }
          },
          ...(showActual
            ? [
                {
                  name: 'Actual error vs ground truth',
                  type: 'line' as const,
                  showSymbol: false,
                  data: data.map((d) => [d.t, d.actual]),
                  lineStyle: { color: sourceColours().fused, width: 1.8 },
                  itemStyle: { color: sourceColours().fused }
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
              label: { formatter: `${limit} m limit`, color: themeColor('assured'), fontSize: 10, position: 'insideEndTop' },
              lineStyle: { color: themeColor('assured'), type: 'dashed', width: 1.5 },
              data: [{ yAxis: limit }]
            }
          }
        ]
      }),
    [data, limit, showActual, theme]
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
  const theme = useResolvedTheme();
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
            lineStyle: { color: themeColor('chart-series-a'), width: 2 },
            itemStyle: { color: themeColor('chart-series-a') },
            markArea: {
              silent: true,
              itemStyle: { opacity: 0.12 },
              data: [
                [{ yAxis: 0, itemStyle: { color: themeColor('critical') } }, { yAxis: 20 }],
                [{ yAxis: 20, itemStyle: { color: themeColor('alert') } }, { yAxis: 50 }],
                [{ yAxis: 50, itemStyle: { color: themeColor('caution') } }, { yAxis: 75 }],
                [{ yAxis: 75, itemStyle: { color: themeColor('assured') } }, { yAxis: 100 }]
              ]
            }
          }
        ]
      }),
    [data, theme]
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
  const theme = useResolvedTheme();
  const option = useMemo<EChartsOption>(() => {
    const modes = [...new Set(data.map((d) => d.mode))];
    const modeIndex = new Map(modes.map((m, i) => [m, i]));
    const tone: Record<string, string> = {
      NORMAL_GNSS: themeColor('assured'),
      GNSS_DEGRADED: themeColor('caution'),
      SPOOFING_SUSPECTED: themeColor('critical'),
      JAMMING_SUSPECTED: themeColor('alert'),
      GNSS_REJECTED: themeColor('caution'),
      RADAR_AIDED_NAVIGATION: themeColor('chart-series-a'),
      LIDAR_AIDED_NAVIGATION: themeColor('chart-series-d'),
      BATHYMETRIC_AIDED_NAVIGATION: themeColor('chart-series-e'),
      DEAD_RECKONING: themeColor('chart-series-f'),
      INS_AIDED_NAVIGATION: themeColor('chart-series-f'),
      LOCAL_POSITIONING_MODE: themeColor('chart-series-g'),
      MANUAL_FALLBACK: themeColor('critical'),
      GNSS_RECOVERY_VALIDATION: themeColor('chart-series-a'),
      INTEGRITY_NOT_ASSURED: themeColor('critical')
    };
    return baseOption({
      grid: { left: 190, right: 18, top: 12, bottom: 32 },
      xAxis: timeAxis(),
      yAxis: {
        type: 'category',
        data: modes.map((m) => m.replace(/_/g, ' ')),
        axisLine: { lineStyle: { color: axisColour() } },
        axisTick: { show: false },
        axisLabel: { color: textColour(), fontSize: 10 },
        splitLine: { show: false }
      },
      tooltip: {
        trigger: 'item',
        backgroundColor: themeColor('chart-tooltip-bg'),
        borderColor: themeColor('chart-tooltip-border'),
        textStyle: { color: themeColor('chart-tooltip-text'), fontSize: 11 },
        formatter: (p: any) => `${p.value[0].toFixed(1)} s<br/>${modes[p.value[1]]?.replace(/_/g, ' ')}`
      },
      series: [
        {
          type: 'scatter',
          symbolSize: 5,
          data: data.map((d) => ({
            value: [d.t, modeIndex.get(d.mode) ?? 0],
            itemStyle: { color: tone[d.mode] ?? themeColor('unknown') }
          }))
        }
      ]
    });
  }, [data, theme]);

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
  const theme = useResolvedTheme();
  const option = useMemo<EChartsOption>(() => {
    const colour: Record<string, string> = {
      REQUIREMENT_MET: themeColor('assured'),
      REQUIREMENT_AT_RISK: themeColor('caution'),
      REQUIREMENT_NOT_MET: themeColor('critical'),
      INSUFFICIENT_INFORMATION: themeColor('unknown')
    };
    return baseOption({
      grid: { left: 52, right: 18, top: 10, bottom: 32 },
      xAxis: timeAxis(),
      yAxis: { type: 'value', min: 0, max: 1, show: false },
      tooltip: {
        trigger: 'item',
        backgroundColor: themeColor('chart-tooltip-bg'),
        borderColor: themeColor('chart-tooltip-border'),
        textStyle: { color: themeColor('chart-tooltip-text'), fontSize: 11 },
        formatter: (p: any) => `${p.value[0].toFixed(1)} s<br/>${p.data.status.replace(/_/g, ' ')}`
      },
      series: [
        {
          type: 'bar',
          barWidth: '100%',
          data: data.map((d) => ({
            value: [d.t, 1],
            status: d.requirement,
            itemStyle: { color: colour[d.requirement] ?? themeColor('unknown') }
          }))
        }
      ]
    });
  }, [data, theme]);

  if (data.length === 0) return <EmptyState title="No compliance history yet" icon="◫" />;
  return <Chart option={option} height={height} />;
}

/** Generic single-series line chart. */
export function LineChart({
  data,
  label,
  unit,
  colour = 'chart-series-a',
  height = 180,
  markLineAt,
  markLineLabel
}: {
  data: SeriesPoint[];
  label: string;
  unit?: string;
  colour?: ThemeToken;
  height?: number;
  markLineAt?: number;
  markLineLabel?: string;
}) {
  const theme = useResolvedTheme();
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
            lineStyle: { color: themeHex(colour), width: 1.8 },
            itemStyle: { color: themeHex(colour) },
            areaStyle: { color: `${themeHex(colour)}18` },
            ...(markLineAt !== undefined
              ? {
                  markLine: {
                    silent: true,
                    symbol: 'none',
                    label: { formatter: markLineLabel ?? String(markLineAt), color: themeColor('caution'), fontSize: 10 },
                    lineStyle: { color: themeColor('caution'), type: 'dashed' },
                    data: [{ yAxis: markLineAt }]
                  }
                }
              : {})
          }
        ]
      }),
    [data, label, unit, colour, markLineAt, markLineLabel, theme]
  );

  if (data.length === 0) return <EmptyState title={`No ${label.toLowerCase()} data yet`} icon="◫" />;
  return <Chart option={option} height={height} />;
}

/** Horizontal bar chart, used for sensor availability and mode durations. */
export function BarChart({
  data,
  unit,
  height = 240,
  colour = 'chart-series-a',
  max
}: {
  data: Array<{ label: string; value: number; colour?: ThemeToken }>;
  unit?: string;
  height?: number;
  colour?: ThemeToken;
  max?: number;
}) {
  const theme = useResolvedTheme();
  const option = useMemo<EChartsOption>(
    () =>
      baseOption({
        grid: { left: 170, right: 40, top: 10, bottom: 28 },
        xAxis: valueAxis(unit ?? '', { max }),
        yAxis: {
          type: 'category',
          data: data.map((d) => d.label),
          axisLine: { lineStyle: { color: axisColour() } },
          axisTick: { show: false },
          axisLabel: { color: textColour(), fontSize: 10 }
        },
        series: [
          {
            type: 'bar',
            data: data.map((d) => ({ value: d.value, itemStyle: { color: themeHex(d.colour ?? colour), borderRadius: [0, 3, 3, 0] } })),
            barMaxWidth: 16,
            label: {
              show: true,
              position: 'right',
              color: textColour(),
              fontSize: 10,
              formatter: (p: any) => `${Number(p.value).toFixed(1)}${unit ? ` ${unit}` : ''}`
            }
          }
        ]
      }),
    [data, unit, colour, max, theme]
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
  const theme = useResolvedTheme();
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
        nameTextStyle: { color: textColour(), fontSize: 10 },
        axisLine: { lineStyle: { color: axisColour() } },
        axisLabel: { color: textColour(), fontSize: 9, interval: 3 }
      },
      yAxis: valueAxis('epochs'),
      series: [
        {
          type: 'bar',
          data: counts.map((c, i) => ({
            value: c,
            itemStyle: { color: (i + 0.5) * width > limit ? themeColor('critical') : themeColor('assured'), opacity: 0.8 }
          })),
          barCategoryGap: '10%'
        }
      ]
    });
  }, [values, limit, theme]);

  if (values.length === 0) return <EmptyState title="No error samples" icon="◫" />;
  return <Chart option={option} height={height} />;
}

/** Compact sparkline for tiles. */
export function Sparkline({
  data,
  colour = 'chart-series-a',
  height = 40,
  limit
}: {
  data: Array<number | null>;
  colour?: ThemeToken;
  height?: number;
  limit?: number;
}) {
  const theme = useResolvedTheme();
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
          lineStyle: { color: themeHex(colour), width: 1.5 },
          areaStyle: { color: `${themeHex(colour)}22` },
          ...(limit !== undefined
            ? {
                markLine: {
                  silent: true,
                  symbol: 'none',
                  label: { show: false },
                  lineStyle: { color: themeColor('caution'), type: 'dashed', width: 1 },
                  data: [{ yAxis: limit }]
                }
              }
            : {})
        }
      ]
    }),
    [data, colour, limit, theme]
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
  const theme = useResolvedTheme();
  const option = useMemo<EChartsOption>(
    () =>
      baseOption({
        legend: { top: 0, right: 0, textStyle: { color: textColour(), fontSize: 10 }, itemWidth: 14, itemHeight: 8 },
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
            lineStyle: { color: themeColor('chart-series-a'), width: 1.8 },
            itemStyle: { color: themeColor('chart-series-a') }
          },
          {
            name: 'Satellites',
            type: 'line',
            showSymbol: false,
            yAxisIndex: 1,
            data: data.map((d) => [d.t, d.satellites]),
            lineStyle: { color: themeColor('assured'), width: 1.5 },
            itemStyle: { color: themeColor('assured') }
          },
          {
            name: 'HDOP',
            type: 'line',
            showSymbol: false,
            yAxisIndex: 1,
            data: data.map((d) => [d.t, d.hdop]),
            lineStyle: { color: themeColor('caution'), width: 1.3, type: 'dashed' },
            itemStyle: { color: themeColor('caution') }
          }
        ]
      }),
    [data, theme]
  );

  if (data.length === 0) return <EmptyState title="No GNSS signal history yet" icon="◈" />;
  return <Chart option={option} height={height} />;
}
