/**
 * Application shell.
 *
 * Holds the active timeframe and minimum-USD filter as state, renders the
 * control bar (timeframe switch, USD filter, legend) and the chart. The visual
 * language is a dark trading terminal: monospaced data, restrained chrome, and
 * the liquidation bubbles as the one expressive element.
 */

import { useEffect, useState } from 'react';
import { Chart } from './Chart.js';
import { loadSettings, saveSettings } from './persist.js';
import type { Timeframe } from './types.js';

/**
 * Ordered timeframes shown in the switcher.
 */
const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];

/**
 * Preset minimum-USD filter thresholds, in dollars. Zero shows everything.
 */
const USD_PRESETS: { label: string; value: number }[] = [
    { label: 'All', value: 0 },
    { label: '$10k', value: 10_000 },
    { label: '$50k', value: 50_000 },
    { label: '$100k', value: 100_000 },
    { label: '$500k', value: 500_000 },
    { label: '$1M', value: 1_000_000 },
];

/**
 * Preset chart refresh intervals in milliseconds, controlling how often the
 * frontend polls for fresh candles and liquidations. Default is one minute.
 */
const REFRESH_PRESETS: { label: string; value: number }[] = [
    { label: '1m', value: 60_000 },
    { label: '3m', value: 180_000 },
    { label: '5m', value: 300_000 },
    { label: '1h', value: 3_600_000 },
];

/**
 * Root component.
 */
export function App(): JSX.Element {
    /**
     * Initialize from persisted settings, falling back to defaults.
     */
    const initial = loadSettings({ timeframe: '1h', minUsd: 0, refreshMs: 60_000 });
    const [timeframe, setTimeframe] = useState<Timeframe>(initial.timeframe);
    const [minUsd, setMinUsd] = useState<number>(initial.minUsd);
    const [refreshMs, setRefreshMs] = useState<number>(initial.refreshMs);

    /**
     * Persist settings whenever any of them changes.
     */
    useEffect(() => {
        saveSettings({ timeframe, minUsd, refreshMs });
    }, [timeframe, minUsd, refreshMs]);

    return (
        <div className="app">
            <header className="bar">
                <div className="brand">
                    <span className="ticker">BTCUSDT</span>
                    <span className="sub">perpetual · liquidations</span>
                </div>

                <div className="group" role="group" aria-label="Timeframe">
                    {TIMEFRAMES.map((tf) => (
                        <button
                            key={tf}
                            type="button"
                            className={tf === timeframe ? 'seg active' : 'seg'}
                            onClick={() => setTimeframe(tf)}
                        >
                            {tf}
                        </button>
                    ))}
                </div>

                <div className="group" role="group" aria-label="Minimum liquidation size">
                    {USD_PRESETS.map((p) => (
                        <button
                            key={p.value}
                            type="button"
                            className={p.value === minUsd ? 'seg active' : 'seg'}
                            onClick={() => setMinUsd(p.value)}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>

                <div className="group" role="group" aria-label="Refresh interval">
                    {REFRESH_PRESETS.map((r) => (
                        <button
                            key={r.value}
                            type="button"
                            className={r.value === refreshMs ? 'seg active' : 'seg'}
                            onClick={() => setRefreshMs(r.value)}
                            title="Chart refresh interval"
                        >
                            ⟳ {r.label}
                        </button>
                    ))}
                </div>

                <div className="legend">
                    <span className="dot long" /> Long liquidated
                    <span className="dot short" /> Short liquidated
                    <span className="dot anomaly" /> &gt;$1M
                </div>
            </header>

            <main className="chart-area">
                <Chart timeframe={timeframe} minUsd={minUsd} refreshMs={refreshMs} />
            </main>
        </div>
    );
}
