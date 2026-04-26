import React, { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, Environment } from '@react-three/drei';
import * as THREE from 'three';

// Field Dimensions (Must match backend)
const FIELD_WIDTH = 600;
const FIELD_HEIGHT = 400; 
const CENTER_X = FIELD_WIDTH / 2;
const CENTER_Z = FIELD_HEIGHT / 2;

const DroneMesh = ({ drone }) => {
  const meshRef = useRef();

  useFrame(() => {
    if (meshRef.current) {
      // Smooth interpolation could be added here, but direct assignment is fine for POC
      // X maps to X, Y maps to Z, altitude is fixed Y
      meshRef.current.position.x = drone.x - CENTER_X;
      meshRef.current.position.z = drone.y - CENTER_Z;
      
      // Add a slight hovering effect based on time
      meshRef.current.position.y = 10 + Math.sin(Date.now() / 200 + parseInt(drone.id.split('-')[1])) * 2;
    }
  });

  return (
    <group ref={meshRef} position={[drone.x - CENTER_X, 10, drone.y - CENTER_Z]}>
      {/* Drone Body */}
      <mesh castShadow>
        <sphereGeometry args={[4, 16, 16]} />
        <meshStandardMaterial color={drone.color} roughness={0.2} metalness={0.8} />
      </mesh>
      
      {/* Spraying Indicator (Cone pointing down) */}
      {drone.state === 'SPRAYING' && (
        <mesh position={[0, -6, 0]}>
          <coneGeometry args={[3, 8, 16]} />
          <meshStandardMaterial color="cyan" transparent opacity={0.4} />
        </mesh>
      )}
    </group>
  );
};

const ZoneOverlay = ({ zone }) => {
  const width = zone.xMax - zone.xMin;
  const depth = zone.yMax - zone.yMin;
  const cx = zone.xMin + width / 2 - CENTER_X;
  const cz = zone.yMin + depth / 2 - CENTER_Z;

  return (
    <mesh position={[cx, 0.1, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[width, depth]} />
      <meshBasicMaterial color="#334155" transparent opacity={0.3} side={THREE.DoubleSide} />
      <lineSegments>
        <edgesGeometry args={[new THREE.PlaneGeometry(width, depth)]} />
        <lineBasicMaterial color="#475569" />
      </lineSegments>
    </mesh>
  );
};

export default function DroneScene({ drones, zones }) {
  return (
    <Canvas shadows camera={{ position: [0, 400, 500], fov: 60 }}>
      {/* Lighting */}
      <ambientLight intensity={0.5} />
      <directionalLight 
        position={[200, 500, 200]} 
        intensity={1} 
        castShadow 
        shadow-mapSize-width={2048} 
        shadow-mapSize-height={2048}
        shadow-camera-left={-400}
        shadow-camera-right={400}
        shadow-camera-top={400}
        shadow-camera-bottom={-400}
      />
      <Environment preset="city" />

      {/* Field Ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[FIELD_WIDTH + 100, FIELD_HEIGHT + 100]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>

      {/* Grid Helper */}
      <Grid 
        args={[FIELD_WIDTH, FIELD_HEIGHT]} 
        position={[0, 0.05, 0]} 
        cellColor="#0f172a" 
        sectionColor="#334155" 
        sectionSize={50} 
        fadeDistance={1000} 
      />

      {/* Render Zones */}
      {zones.map((zone, idx) => (
        <ZoneOverlay key={`zone-${idx}`} zone={zone} />
      ))}

      {/* Render Drones */}
      {drones.map((drone) => (
        <DroneMesh key={drone.id} drone={drone} />
      ))}

      {/* Controls */}
      <OrbitControls 
        makeDefault 
        maxPolarAngle={Math.PI / 2 - 0.05} // Prevent going below ground
        minDistance={50}
        maxDistance={800}
      />
    </Canvas>
  );
}
