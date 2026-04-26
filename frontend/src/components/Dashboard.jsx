import React, { useState, useEffect, useRef, useMemo } from 'react';

// ─── Utilities ────────────────────────────────────────────────────────────────
const formatTime = (seconds) => {
  if (!seconds || seconds <= 0) return '--:--';
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

const Sparkline = ({ data, color, width = 48, height = 12 }) => {
  if (!data || data.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...data) - 1;
  const max = Math.max(...data) + 1;
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map((d, i) => `${i * step},${height - ((d - min) / range) * height}`).join(' ');
  return (
    <svg width={width} height={height} className="opacity-50">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

// ─── Status config ────────────────────────────────────────────────────────────
const STATUS_CFG = {
  IDLE:             { label: 'IDLE',     bg: 'bg-slate-500/10',   text: 'text-slate-500'   },
  SPRAYING:         { label: 'SPRAYING', bg: 'bg-emerald-500/10', text: 'text-emerald-600' },
  RETURNING:        { label: 'RTB',      bg: 'bg-amber-500/10',   text: 'text-amber-600'   },
  CHARGING:         { label: 'CHARGING', bg: 'bg-violet-500/10',  text: 'text-violet-500'  },
  MISSION_COMPLETE: { label: 'DONE',     bg: 'bg-sky-500/10',     text: 'text-sky-600'     },
};

// ─── Event type → border color ────────────────────────────────────────────────
const EVENT_COLORS = {
  success: 'border-l-emerald-500 bg-emerald-500/5',
  warning: 'border-l-amber-500 bg-amber-500/5',
  error:   'border-l-red-500 bg-red-500/5',
  info:    'border-l-sky-500 bg-sky-500/5',
};

// ─── Icons ────────────────────────────────────────────────────────────────────
const ChevronIcon = ({ open }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>
    <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
  </svg>
);

const PanelIcon = ({ open }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" className="opacity-60">
    {open
      ? <path d="M9 3L5 7L9 11" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      : <path d="M5 3L9 7L5 11" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    }
  </svg>
);

const CrosshairIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" className="opacity-40">
    <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1" fill="none" />
    <line x1="6" y1="0" x2="6" y2="3" stroke="currentColor" strokeWidth="1" />
    <line x1="6" y1="9" x2="6" y2="12" stroke="currentColor" strokeWidth="1" />
    <line x1="0" y1="6" x2="3" y2="6" stroke="currentColor" strokeWidth="1" />
    <line x1="9" y1="6" x2="12" y2="6" stroke="currentColor" strokeWidth="1" />
  </svg>
);

// Wind direction compass arrow
const WindArrow = ({ direction, speed }) => {
  const rad = (direction || 0) * Math.PI / 180;
  const len = 4 + speed * 0.8;
  const x2 = 6 + Math.cos(rad) * len;
  const y2 = 6 - Math.sin(rad) * len;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="0.5" fill="none" opacity="0.2" />
      <line x1="6" y1="6" x2={x2} y2={y2} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
export default function Dashboard({
  telemetry, isConnected,
  selectedDroneId, selectedZoneId, toggles,
  onSelectDrone, onSelectZone, onResetView, onToggle
}) {
  const { metrics, drones, zones, elapsed_s, events, wind } = telemetry;
  const [batteryHistory, setBatteryHistory] = useState({});
  const [eventLog, setEventLog] = useState([]);
  const [expandedDrone, setExpandedDrone] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [eventsOpen, setEventsOpen] = useState(true);
  const logEndRef = useRef(null);

  // Battery history
  useEffect(() => {
    if (!drones || drones.length === 0) return;
    setBatteryHistory(prev => {
      const next = { ...prev };
      drones.forEach(d => {
        if (!next[d.id]) next[d.id] = [];
        next[d.id] = [...next[d.id], d.battery].slice(-30);
      });
      return next;
    });
  }, [elapsed_s]);

  // Event accumulation — backend now sends typed events
  useEffect(() => {
    if (events && events.length > 0) {
      setEventLog(prev => {
        const newEvents = events.map(e => ({
          id: e.id,
          time: elapsed_s,
          msg: e.message,
          type: e.type || 'info',
        }));
        return [...prev, ...newEvents].slice(-100);
      });
    }
  }, [events, elapsed_s]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [eventLog]);

  const completedZones = metrics.completed_zones || 0;
  const missionEta     = metrics.mission_eta_seconds || 0;

  return (
    <div className="w-full h-full flex flex-col pointer-events-none select-none">

      {/* ═══════ TOP BAR ═══════ */}
      <div className="flex items-start p-3 gap-3">

        {/* ─── HUD (Top Left) ─── */}
        <div className="glass-dark px-3 py-2 pointer-events-auto flex items-center gap-3 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-400 pulse-slow' : 'bg-red-500'}`} />
            <span className="text-[10px] font-bold text-white/90 tracking-widest">AGRITWIN</span>
          </div>
          <div className="h-4 w-px bg-white/10" />
          <div className="text-center">
            <div className="text-[8px] text-white/40 uppercase tracking-wider">Coverage</div>
            <div className="text-xs font-semibold mono text-white/90">{metrics.total_coverage_percent?.toFixed(1) || '0.0'}%</div>
          </div>
          <div className="text-center">
            <div className="text-[8px] text-white/40 uppercase tracking-wider">Active</div>
            <div className="text-xs font-semibold mono text-emerald-400">{metrics.active_drones || 0}<span className="text-white/30">/6</span></div>
          </div>
          <div className="text-center">
            <div className="text-[8px] text-white/40 uppercase tracking-wider">Time</div>
            <div className="text-xs font-semibold mono text-white/90">{formatTime(elapsed_s || 0)}</div>
          </div>
          <div className="h-4 w-px bg-white/10" />
          {/* Wind indicator */}
          <div className="flex items-center gap-1.5" title={`Wind: ${wind?.speed?.toFixed(1) || 0} @ ${wind?.direction_deg || 0}°`}>
            <div className="text-white/50">
              <WindArrow direction={wind?.direction_deg || 0} speed={wind?.speed || 0} />
            </div>
            <div className="text-center">
              <div className="text-[7px] text-white/30 uppercase">Wind</div>
              <div className="text-[9px] mono text-white/60">{wind?.speed?.toFixed(1) || '0.0'}</div>
            </div>
          </div>
          {/* ETA */}
          <div className="text-center">
            <div className="text-[8px] text-white/40 uppercase tracking-wider">ETA</div>
            <div className="text-xs font-semibold mono text-amber-400">{missionEta > 0 ? formatTime(missionEta) : '--:--'}</div>
          </div>
        </div>

        {/* ─── Mission Progress Bar ─── */}
        <div className="glass-dark px-3 py-2 pointer-events-auto flex-1 max-w-xl">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] text-white/40 uppercase tracking-widest font-semibold">Mission Progress</span>
            <span className="text-[9px] mono text-white/50">
              {completedZones}/6 zones • {Math.round(metrics.total_trees_sprayed || 0).toLocaleString()} trees
            </span>
          </div>
          <div className="flex gap-1">
            {(zones || []).map(zone => {
              const isActive = zone.status === 'ACTIVE';
              const isComplete = zone.status === 'COMPLETED';
              const pct = zone.completion_pct || 0;
              return (
                <button
                  key={zone.id}
                  onClick={() => onSelectZone(zone.id)}
                  className={`flex-1 h-5 rounded relative overflow-hidden transition-all duration-300 cursor-pointer
                    ${selectedZoneId === zone.id ? 'ring-1 ring-white/50' : ''}
                    ${isComplete ? 'bg-emerald-500/30' : isActive ? 'bg-sky-500/20' : 'bg-white/5'}`}
                >
                  {isActive && (
                    <div className="absolute inset-y-0 left-0 bg-sky-400/40 transition-all duration-500" style={{ width: `${pct}%` }} />
                  )}
                  <span className="absolute inset-0 flex items-center justify-center text-[8px] mono text-white/60 font-medium">
                    Z{zone.id.split('_')[1]}
                    {isComplete && ' ✓'}
                    {isActive && ` ${pct.toFixed(0)}%`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ─── View Controls ─── */}
        <div className="glass-dark px-2 py-2 pointer-events-auto flex items-center gap-1 flex-shrink-0">
          <button onClick={onResetView} className="px-2 py-1 rounded text-[9px] text-white/60 hover:text-white hover:bg-white/10 transition-colors" title="Reset camera">
            <CrosshairIcon />
          </button>
          {[
            { key: 'showTrails', label: 'T' },
            { key: 'showZones', label: 'Z' },
            { key: 'showLabels', label: 'L' },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => onToggle(t.key)}
              className={`w-6 h-6 rounded text-[9px] font-bold transition-colors ${
                toggles[t.key] ? 'bg-white/15 text-white/80' : 'bg-transparent text-white/25'
              } hover:bg-white/10`}
              title={t.key}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ═══════ MIDDLE: Events + Sidebar ═══════ */}
      <div className="flex-1 flex justify-between items-end p-3 pt-0 gap-3 min-h-0">

        {/* ─── Events Feed (Bottom Left) ─── */}
        <div className={`flex flex-col transition-all duration-300 ${eventsOpen ? 'w-[300px]' : 'w-[36px]'}`}>
          <button
            onClick={() => setEventsOpen(!eventsOpen)}
            className="glass-dark px-2 py-1.5 pointer-events-auto mb-1 flex items-center gap-1.5 self-start hover:bg-white/5 transition-colors rounded-lg"
          >
            <PanelIcon open={eventsOpen} />
            {eventsOpen && <span className="text-[9px] text-white/50 uppercase tracking-widest font-semibold">Events</span>}
            {eventsOpen && <span className="text-[8px] mono text-white/20 ml-1">{eventLog.length}</span>}
            {!eventsOpen && eventLog.length > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 pulse-slow" />
            )}
          </button>
          {eventsOpen && (
            <div className="glass-dark p-2 pointer-events-auto max-h-[260px] overflow-hidden flex flex-col rounded-lg">
              <div className="space-y-0.5 overflow-y-auto flex-1 scrollbar-thin">
                {eventLog.length === 0 && (
                  <div className="text-[10px] text-white/20 italic py-2 text-center">Waiting for mission events…</div>
                )}
                {eventLog.map((ev, i) => (
                  <div key={ev.id || i} className={`text-[9px] mono px-2 py-1 rounded border-l-2 flex gap-2 ${EVENT_COLORS[ev.type] || EVENT_COLORS.info}`}>
                    <span className="text-white/25 flex-shrink-0">{formatTime(ev.time)}</span>
                    <span className={`truncate ${ev.type === 'error' ? 'text-red-300' : ev.type === 'warning' ? 'text-amber-300' : 'text-white/70'}`}>
                      {ev.msg}
                    </span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
        </div>

        {/* ─── Right Sidebar: Fleet Panel ─── */}
        <div className={`flex flex-col items-end transition-all duration-300 ${sidebarOpen ? 'w-[280px]' : 'w-[36px]'}`}>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="glass-dark px-2 py-1.5 pointer-events-auto mb-1 flex items-center gap-1.5 self-end hover:bg-white/5 transition-colors rounded-lg"
          >
            {sidebarOpen && <span className="text-[9px] text-white/50 uppercase tracking-widest font-semibold">Fleet</span>}
            <PanelIcon open={!sidebarOpen} />
          </button>

          {sidebarOpen && (
            <div className="glass-dark pointer-events-auto w-full overflow-hidden rounded-lg flex flex-col max-h-[70vh]">

              {/* Battery heatmap */}
              <div className="px-2 pt-2 pb-1 border-b border-white/5">
                <div className="text-[8px] text-white/30 uppercase tracking-widest mb-1">Battery Overview</div>
                <div className="flex gap-0.5">
                  {drones.map(d => {
                    const pct = d.battery;
                    const bg = pct < 20 ? 'bg-red-500' : pct < 50 ? 'bg-amber-500' : 'bg-emerald-500';
                    const isCharging = d.status === 'CHARGING';
                    return (
                      <div
                        key={d.id}
                        className={`flex-1 h-1.5 rounded-full ${bg} transition-all duration-500 ${isCharging ? 'animate-pulse' : ''}`}
                        style={{ opacity: 0.3 + (pct / 100) * 0.7 }}
                        title={`${d.id}: ${pct}% ${isCharging ? '(charging)' : ''}`}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Drone list */}
              <div className="overflow-y-auto flex-1 scrollbar-thin">
                {drones.map(drone => {
                  const cfg = STATUS_CFG[drone.status] || STATUS_CFG.IDLE;
                  const hue = drone.color_hue;
                  const accent = `hsl(${hue}, 45%, 45%)`;
                  const isSelected = selectedDroneId === drone.id;
                  const isExpanded = expandedDrone === drone.id;

                  return (
                    <div key={drone.id} className={`border-b border-white/5 last:border-b-0 transition-colors ${isSelected ? 'bg-white/5' : ''}`}>

                      {/* Compact row */}
                      <button
                        onClick={() => onSelectDrone(drone.id)}
                        className="w-full px-2 py-1.5 flex items-center gap-2 hover:bg-white/5 transition-colors text-left"
                      >
                        <div className="w-2 h-2 rounded-full flex-shrink-0 relative" style={{ backgroundColor: accent }}>
                          {drone.motor_fault && (
                            <div className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-red-500 pulse-slow" />
                          )}
                        </div>
                        <span className="text-[10px] font-semibold text-white/80 flex-1 tracking-wide">
                          {drone.id.replace('_', ' ').toUpperCase()}
                        </span>
                        <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold tracking-wider ${cfg.bg} ${cfg.text}`}>
                          {cfg.label}
                        </span>
                        <span className={`text-[10px] mono font-medium w-10 text-right ${
                          drone.battery < 20 ? 'text-red-400' : drone.status === 'CHARGING' ? 'text-violet-400' : 'text-white/60'
                        }`}>
                          {drone.battery}%
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); setExpandedDrone(isExpanded ? null : drone.id); }}
                          className="text-white/30 hover:text-white/60 p-0.5"
                        >
                          <ChevronIcon open={isExpanded} />
                        </button>
                      </button>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="px-3 pb-2 pt-0.5 animate-slide-down">
                          {/* Battery bar */}
                          <div className="mb-2">
                            <div className="flex items-center gap-2 mb-0.5">
                              <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
                                <div
                                  className={`h-full battery-fill rounded-full ${drone.status === 'CHARGING' ? 'animate-pulse' : ''}`}
                                  style={{
                                    width: `${Math.max(0, drone.battery)}%`,
                                    backgroundColor: drone.battery < 20 ? '#ef4444' : drone.battery < 50 ? '#f59e0b' : '#10b981',
                                  }}
                                />
                              </div>
                              <Sparkline data={batteryHistory[drone.id]} color={accent} />
                            </div>
                          </div>

                          {/* Telemetry */}
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px]">
                            <div className="flex justify-between">
                              <span className="text-white/30">Zone</span>
                              <span className="text-white/70 mono">{drone.assigned_zone?.replace('_', ' ').toUpperCase()}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-white/30">Speed</span>
                              <span className="text-white/70 mono">{drone.speed} m/s</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-white/30">Distance</span>
                              <span className="text-white/70 mono">{drone.distance_traveled} m</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-white/30">Area</span>
                              <span className="text-white/70 mono">{drone.spraying_area} m²</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-white/30">Missions</span>
                              <span className="text-white/70 mono">{drone.missions_flown}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-white/30">Efficiency</span>
                              <span className="text-white/70 mono">{drone.efficiency} t/%</span>
                            </div>
                          </div>

                          {/* Prediction (only when spraying) */}
                          {drone.status === 'SPRAYING' && drone.prediction && (
                            <div className="mt-2 pt-1.5 border-t border-white/5">
                              <div className="text-[8px] text-white/25 uppercase tracking-widest mb-1">Prediction</div>
                              <div className="grid grid-cols-3 gap-1 text-[9px]">
                                <div className="text-center">
                                  <div className="text-white/25">ETA</div>
                                  <div className="mono text-white/70">{formatTime(drone.prediction.etaSeconds)}</div>
                                </div>
                                <div className="text-center">
                                  <div className="text-white/25">Bat@End</div>
                                  <div className={`mono ${drone.prediction.batteryAtFinish < 20 ? 'text-red-400' : 'text-white/70'}`}>
                                    {drone.prediction.batteryAtFinish}%
                                  </div>
                                </div>
                                <div className="text-center">
                                  <div className="text-white/25">Conf</div>
                                  <div className="mono text-white/70">{(drone.prediction.confidence * 100).toFixed(0)}%</div>
                                </div>
                              </div>
                              {!drone.prediction.canFinishZone && (
                                <div className="text-[8px] text-amber-400 mt-1 text-center">⚠ May not finish zone</div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
