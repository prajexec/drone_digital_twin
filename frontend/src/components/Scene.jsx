import React, { useMemo, useRef, useEffect, useCallback } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, Sky, Text } from '@react-three/drei';
import * as THREE from 'three';
import Drone from '../models/Drone';

// Constants to match backend fieldMath.js
const FIELD_WIDTH = 600;
const FIELD_DEPTH = 200;
const CENTER_X = FIELD_WIDTH / 2;
const CENTER_Z = FIELD_DEPTH / 2;

// ─── Zone overlay ─────────────────────────────────────────────────────────────
const ZoneOverlay = ({ zone, isSelected, showZones, showLabels, onClick }) => {
  const width = zone.bounds.xMax - zone.bounds.xMin;
  const depth = zone.bounds.zMax - zone.bounds.zMin;
  const cx = zone.cx - CENTER_X;
  const cz = zone.cz - CENTER_Z;

  const edgeGeo = useMemo(
    () => new THREE.EdgesGeometry(new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2)),
    [width, depth]
  );

  if (!showZones) return null;

  let fillColor = null;
  let fillOpacity = 0;
  if (zone.status === 'ACTIVE') { fillColor = '#93c5fd'; fillOpacity = 0.12; }
  else if (zone.status === 'COMPLETED') { fillColor = '#86efac'; fillOpacity = 0.18; }

  const lineColor = isSelected ? '#60a5fa' : '#cbd5e1';

  return (
    <group position={[cx, 0.05, cz]}>
      {/* Click target */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.03, 0]}
        onClick={(e) => { e.stopPropagation(); onClick(zone.id); }}
        visible={false}
      >
        <planeGeometry args={[width, depth]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>

      {/* Boundary lines */}
      <lineSegments>
        <primitive object={edgeGeo} attach="geometry" />
        <lineBasicMaterial color={lineColor} linewidth={1} />
      </lineSegments>

      {/* Selection ring */}
      {isSelected && (
        <lineSegments>
          <primitive object={edgeGeo} attach="geometry" />
          <lineBasicMaterial color="#60a5fa" linewidth={2} />
        </lineSegments>
      )}

      {/* Status fill */}
      {fillColor && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <planeGeometry args={[width, depth]} />
          <meshBasicMaterial color={fillColor} transparent opacity={fillOpacity} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Zone label */}
      {showLabels && (
        <>
          <Text
            position={[0, 0.3, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            fontSize={8}
            color="#94a3b8"
            anchorX="center"
            anchorY="middle"
            font="https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfMZg.ttf"
          >
            {zone.id.replace('_', ' ').toUpperCase()}
          </Text>
          {zone.completion_pct > 0 && (
            <Text
              position={[0, 0.3, 12]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={5}
              color={zone.status === 'COMPLETED' ? '#16a34a' : '#64748b'}
              anchorX="center"
              anchorY="middle"
              font="https://fonts.gstatic.com/s/jetbrainsmono/v18/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKxjPVmUsaaDhw.ttf"
            >
              {zone.completion_pct.toFixed(0)}%
            </Text>
          )}
        </>
      )}
    </group>
  );
};

// ─── Base Station ─────────────────────────────────────────────────────────────
const BaseStation = ({ x, z, droneId, showLabels }) => (
  <group position={[x - CENTER_X, 0, z - CENTER_Z]}>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} receiveShadow>
      <circleGeometry args={[6, 32]} />
      <meshStandardMaterial color="#94a3b8" roughness={0.9} />
    </mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.08, 0]}>
      <ringGeometry args={[4, 5, 32]} />
      <meshStandardMaterial color="#64748b" roughness={0.8} />
    </mesh>
    <mesh position={[0, 1.5, 0]} castShadow>
      <boxGeometry args={[2, 3, 2]} />
      <meshStandardMaterial color="#475569" roughness={0.6} metalness={0.3} />
    </mesh>
    <mesh position={[0, 3.5, 0]}>
      <sphereGeometry args={[0.4]} />
      <meshStandardMaterial color="#22c55e" emissive="#22c55e" emissiveIntensity={0.5} />
    </mesh>
    {showLabels && (
      <Text
        position={[0, 5, 0]}
        fontSize={3}
        color="#475569"
        anchorX="center"
        anchorY="bottom"
        font="https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfMZg.ttf"
      >
        {droneId ? droneId.replace('_', ' ').toUpperCase() : 'DOCK'}
      </Text>
    )}
  </group>
);

// ─── Sub-strip divider lines ──────────────────────────────────────────────────
const StripLines = ({ zone }) => {
  const zMin = zone.bounds.zMin - CENTER_Z;
  const lines = [40, 80].map(offset => zMin + offset).filter(z => z < zone.bounds.zMax - CENTER_Z);

  return (
    <group>
      {lines.map((lineZ, i) => (
        <line key={i}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              array={new Float32Array([
                zone.bounds.xMin - CENTER_X, 0.08, lineZ,
                zone.bounds.xMax - CENTER_X, 0.08, lineZ,
              ])}
              count={2}
              itemSize={3}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#e2e8f0" linewidth={1} />
        </line>
      ))}
    </group>
  );
};

// ─── Camera controller with follow-drone + zoom-to-zone ───────────────────────
const CameraController = ({ selectedDroneId, cameraTarget, drones }) => {
  const { camera, gl } = useThree();
  const controlsRef = useRef();
  const isFollowing = useRef(false);
  const targetPos = useRef(new THREE.Vector3());

  // Follow selected drone
  useFrame(() => {
    if (!controlsRef.current) return;
    
    if (selectedDroneId) {
      const drone = drones?.find(d => d.id === selectedDroneId);
      if (drone) {
        const dx = drone.position.x - CENTER_X;
        const dz = drone.position.z - CENTER_Z;
        const dy = drone.position.y;
        
        targetPos.current.set(dx, dy, dz);
        controlsRef.current.target.lerp(targetPos.current, 0.05);

        // If just started following, also move camera closer
        if (!isFollowing.current) {
          isFollowing.current = true;
          const camTarget = new THREE.Vector3(dx + 40, dy + 80, dz + 60);
          camera.position.lerp(camTarget, 0.02);
        }
      }
    } else if (cameraTarget) {
      const ct = new THREE.Vector3(cameraTarget.x - CENTER_X, cameraTarget.y, cameraTarget.z - CENTER_Z);
      controlsRef.current.target.lerp(ct, 0.05);
      isFollowing.current = false;
    } else {
      // Reset to default view
      const def = new THREE.Vector3(0, 0, 0);
      controlsRef.current.target.lerp(def, 0.02);
      isFollowing.current = false;
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      domElement={gl.domElement}
      maxPolarAngle={Math.PI / 2 - 0.05}
      minDistance={30}
      maxDistance={1000}
      enableDamping
      dampingFactor={0.08}
    />
  );
};

// Hoist camera config
const CAMERA = { position: [0, 350, 320], fov: 45 };

// ─── Main Scene ───────────────────────────────────────────────────────────────
export default function Scene({ 
  telemetry, selectedDroneId, selectedZoneId, cameraTarget, toggles,
  onSelectDrone, onSelectZone 
}) {
  const { drones, zones } = telemetry;

  return (
    <Canvas shadows camera={CAMERA}>
      <Sky
        sunPosition={[100, 20, 100]}
        turbidity={0.4}
        rayleigh={0.5}
        mieCoefficient={0.005}
        mieDirectionalG={0.8}
      />

      <ambientLight intensity={0.5} color="#f0f0f0" />
      <directionalLight
        position={[150, 300, 100]}
        intensity={1.5}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-FIELD_WIDTH / 2 - 50}
        shadow-camera-right={FIELD_WIDTH / 2 + 50}
        shadow-camera-top={FIELD_DEPTH / 2 + 50}
        shadow-camera-bottom={-FIELD_DEPTH / 2 - 50}
        shadow-camera-near={1}
        shadow-camera-far={1000}
        shadow-bias={-0.0001}
      />
      <directionalLight position={[-100, 100, -50]} intensity={0.3} />

      {/* Ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[FIELD_WIDTH + 300, FIELD_DEPTH + 300]} />
        <meshStandardMaterial color="#6b7a4e" roughness={0.95} metalness={0} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, 0.02, 0]}>
        <planeGeometry args={[FIELD_WIDTH + 20, FIELD_DEPTH + 20]} />
        <meshStandardMaterial color="#7a8c5a" roughness={0.9} metalness={0} />
      </mesh>

      {/* Zones */}
      {zones && zones.map(zone => (
        <React.Fragment key={zone.id}>
          <ZoneOverlay
            zone={zone}
            isSelected={selectedZoneId === zone.id}
            showZones={toggles.showZones}
            showLabels={toggles.showLabels}
            onClick={onSelectZone}
          />
          {toggles.showZones && <StripLines zone={zone} />}
        </React.Fragment>
      ))}

      {/* Base stations */}
      {drones && drones.map((drone, i) => (
        <BaseStation
          key={drone.id}
          x={-50}
          z={zones[i] ? zones[i].bounds.zMin + 15 + (i % 2 === 1 ? 20 : 0) : i * 35}
          droneId={drone.id}
          showLabels={toggles.showLabels}
        />
      ))}

      {/* Drones */}
      {drones && drones.map(drone => (
        <Drone
          key={drone.id}
          drone={drone}
          offsetX={CENTER_X}
          offsetZ={CENTER_Z}
          isSelected={selectedDroneId === drone.id}
          showTrail={toggles.showTrails}
          onClick={onSelectDrone}
        />
      ))}

      {/* Camera */}
      <CameraController
        selectedDroneId={selectedDroneId}
        cameraTarget={cameraTarget}
        drones={drones}
      />
    </Canvas>
  );
}
