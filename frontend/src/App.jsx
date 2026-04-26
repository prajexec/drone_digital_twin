import React, { useEffect, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import Dashboard from './components/Dashboard';
import Scene from './components/Scene';

const SOCKET_URL = 'http://localhost:4000';

export default function App() {
  const [telemetry, setTelemetry] = useState({
    timestamp: 0,
    tick: 0,
    elapsed_s: 0,
    events: [],
    wind: { direction_deg: 0, speed: 0, dx: 0, dz: 0 },
    metrics: {
      total_coverage_percent: 0,
      active_drones: 0,
      charging_drones: 0,
      total_trees_sprayed: 0,
      total_trees: 0,
      completed_zones: 0,
      mission_eta_seconds: 0,
    },
    drones: [],
    zones: []
  });
  
  const [isConnected, setIsConnected] = useState(false);

  // ─── Shared interaction state ─────────────────────────────────
  const [selectedDroneId, setSelectedDroneId] = useState(null);
  const [selectedZoneId, setSelectedZoneId] = useState(null);
  const [cameraTarget, setCameraTarget] = useState(null); // { x, y, z } or null for default
  const [toggles, setToggles] = useState({
    showTrails: true,
    showZones: true,
    showLabels: true,
  });

  const handleSelectDrone = useCallback((droneId) => {
    if (selectedDroneId === droneId) {
      // Deselect
      setSelectedDroneId(null);
      setCameraTarget(null);
    } else {
      setSelectedDroneId(droneId);
      setSelectedZoneId(null);
      // Camera will follow drone — Scene reads selectedDroneId
    }
  }, [selectedDroneId]);

  const handleSelectZone = useCallback((zoneId) => {
    if (selectedZoneId === zoneId) {
      setSelectedZoneId(null);
      setCameraTarget(null);
    } else {
      setSelectedZoneId(zoneId);
      setSelectedDroneId(null);
      // Find zone center for camera
      const zone = telemetry.zones.find(z => z.id === zoneId);
      if (zone) {
        setCameraTarget({ x: zone.cx, y: 0, z: zone.cz });
      }
    }
  }, [selectedZoneId, telemetry.zones]);

  const handleResetView = useCallback(() => {
    setSelectedDroneId(null);
    setSelectedZoneId(null);
    setCameraTarget(null);
  }, []);

  const handleToggle = useCallback((key) => {
    setToggles(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  useEffect(() => {
    const socket = io(SOCKET_URL);

    socket.on('connect', () => {
      setIsConnected(true);
      console.log('Connected to Digital Twin Engine');
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      console.log('Disconnected from Digital Twin Engine');
    });

    socket.on('telemetry_update', (data) => {
      setTelemetry(data);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <div className="relative w-full h-screen overflow-hidden bg-slate-100 text-slate-900 font-sans">
      
      {/* 3D Simulation Canvas — full viewport */}
      <div className="absolute inset-0 z-0">
        <Scene 
          telemetry={telemetry} 
          selectedDroneId={selectedDroneId}
          selectedZoneId={selectedZoneId}
          cameraTarget={cameraTarget}
          toggles={toggles}
          onSelectDrone={handleSelectDrone}
          onSelectZone={handleSelectZone}
        />
      </div>

      {/* UI Overlay — pointer-events-none wrapper */}
      <div className="absolute inset-0 z-10 pointer-events-none">
        <Dashboard 
          telemetry={telemetry} 
          isConnected={isConnected} 
          selectedDroneId={selectedDroneId}
          selectedZoneId={selectedZoneId}
          toggles={toggles}
          onSelectDrone={handleSelectDrone}
          onSelectZone={handleSelectZone}
          onResetView={handleResetView}
          onToggle={handleToggle}
        />
      </div>
      
    </div>
  );
}
