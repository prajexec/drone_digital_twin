import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Trail, Sphere, Ring } from '@react-three/drei';
import * as THREE from 'three';

/**
 * Procedural 3D Drone Model with telemetry synchronization.
 * Supports states: IDLE, SPRAYING, RETURNING, MISSION_COMPLETE
 * Supports: selection ring, toggleable trails, click-to-select
 */
export default function Drone({ drone, offsetX, offsetZ, isSelected, showTrail, onClick }) {
  const groupRef = useRef();
  const rotorRefs = useRef([]);
  const ringRef = useRef();

  const x = drone.position.x - offsetX;
  const y = drone.position.y;
  const z = drone.position.z - offsetZ;

  const mainColor = useMemo(() => new THREE.Color(`hsl(${drone.color_hue}, 55%, 45%)`), [drone.color_hue]);
  const isAirborne  = drone.status === 'SPRAYING' || drone.status === 'RETURNING';
  const isComplete  = drone.status === 'MISSION_COMPLETE';
  const isSpraying  = drone.status === 'SPRAYING';
  const isCharging  = drone.status === 'CHARGING';
  const hasFault    = drone.motor_fault;

  useFrame((state) => {
    if (!groupRef.current) return;

    const targetPos = new THREE.Vector3(x, y, z);
    groupRef.current.position.lerp(targetPos, 0.15);

    if (isAirborne) {
      groupRef.current.position.y += Math.sin(state.clock.elapsedTime * 3 + drone.color_hue) * 0.08;
    }

    if (drone.target_waypoint && isAirborne) {
      const tx = drone.target_waypoint.x - offsetX;
      const tz = drone.target_waypoint.z - offsetZ;
      const dx = tx - groupRef.current.position.x;
      const dz = tz - groupRef.current.position.z;
      
      const targetRotationX = Math.atan2(dz, 100) * 0.3;
      const targetRotationZ = Math.atan2(-dx, 100) * 0.3;
      
      groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, targetRotationX, 0.08);
      groupRef.current.rotation.z = THREE.MathUtils.lerp(groupRef.current.rotation.z, targetRotationZ, 0.08);
    } else {
      groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, 0, 0.1);
      groupRef.current.rotation.z = THREE.MathUtils.lerp(groupRef.current.rotation.z, 0, 0.1);
    }

    const rotorSpeed = isComplete ? 0 : isCharging ? 0.02 : (isAirborne ? 0.5 : 0.1);
    rotorRefs.current.forEach(rotor => {
      if (rotor) rotor.rotation.y += rotorSpeed;
    });

    // Pulse selection ring
    if (ringRef.current) {
      ringRef.current.rotation.z = state.clock.elapsedTime * 0.5;
    }
  });

  return (
    <group ref={groupRef} position={[x, y, z]}>
      
      {/* Click hitbox (invisible sphere) */}
      <mesh 
        onClick={(e) => { e.stopPropagation(); onClick && onClick(drone.id); }}
      >
        <sphereGeometry args={[5]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>

      {/* Selection ring on ground */}
      {isSelected && (
        <group position={[0, -y + 0.2, 0]} ref={ringRef}>
          <Ring args={[7, 8, 32]} rotation={[-Math.PI / 2, 0, 0]}>
            <meshBasicMaterial color={mainColor} transparent opacity={0.5} side={THREE.DoubleSide} />
          </Ring>
          <Ring args={[9, 9.5, 32]} rotation={[-Math.PI / 2, 0, 0]}>
            <meshBasicMaterial color={mainColor} transparent opacity={0.25} side={THREE.DoubleSide} />
          </Ring>
        </group>
      )}

      {/* Trail — only when airborne and toggled on */}
      {isAirborne && showTrail && (
        <Trail
          width={1.5}
          color={mainColor}
          length={20}
          decay={2}
          attenuation={(t) => t * t}
        >
          <group position={[0, 0, 0]} />
        </Trail>
      )}

      {/* Motor fault warning ring */}
      {hasFault && isAirborne && (
        <Ring args={[5, 5.5, 16]} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]}>
          <meshBasicMaterial color="#ef4444" transparent opacity={0.6} side={THREE.DoubleSide} />
        </Ring>
      )}

      {/* Drone Body — dark slate chassis */}
      <mesh castShadow>
        <boxGeometry args={[4, 1.2, 4]} />
        <meshStandardMaterial 
          color={isComplete ? '#64748b' : '#1e293b'} 
          metalness={0.4} 
          roughness={0.4} 
        />
      </mesh>

      {/* Center dome */}
      <mesh position={[0, 0.8, 0]} castShadow>
        <sphereGeometry args={[1.2, 16, 16]} />
        <meshStandardMaterial 
          color={mainColor} 
          emissive={isAirborne ? mainColor : '#000000'} 
          emissiveIntensity={isAirborne ? 0.3 : 0} 
          metalness={0.3}
          roughness={0.5}
        />
      </mesh>

      {/* Arms & Rotors */}
      {[[-3, -3], [3, 3], [-3, 3], [3, -3]].map(([rx, rz], i) => (
        <group key={i} position={[rx, 0, rz]}>
          <mesh position={[-rx/2, 0, -rz/2]} rotation={[0, Math.atan2(rx, rz), 0]}>
            <cylinderGeometry args={[0.15, 0.15, Math.hypot(rx, rz)]} />
            <meshStandardMaterial color="#475569" metalness={0.5} roughness={0.3} />
          </mesh>
          <mesh ref={el => (rotorRefs.current[i] = el)} position={[0, 0.8, 0]}>
            <cylinderGeometry args={[1.8, 1.8, 0.08, 12]} />
            <meshStandardMaterial color="#94a3b8" transparent opacity={isAirborne ? 0.4 : 0.7} />
          </mesh>
          <mesh position={[0, 0.4, 0]}>
            <cylinderGeometry args={[0.4, 0.4, 0.5, 8]} />
            <meshStandardMaterial color="#334155" metalness={0.6} roughness={0.3} />
          </mesh>
        </group>
      ))}

      {/* Spray cone */}
      {isSpraying && (
        <group position={[0, -0.8, 0]}>
          <mesh position={[0, -5, 0]}>
            <coneGeometry args={[3.5, 10, 16]} />
            <meshStandardMaterial 
              color="#a7f3d0" transparent opacity={0.15} 
              side={THREE.DoubleSide} depthWrite={false}
            />
          </mesh>
          <mesh position={[0, -3.5, 0]}>
            <coneGeometry args={[1.2, 7, 8]} />
            <meshBasicMaterial color="#d1fae5" transparent opacity={0.3} />
          </mesh>
        </group>
      )}

      {/* Amber beacon when returning */}
      {drone.status === 'RETURNING' && (
        <Sphere args={[0.4]} position={[0, 2, 0]}>
          <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.8} />
        </Sphere>
      )}

      {/* Green beacon when landed */}
      {isComplete && (
        <Sphere args={[0.3]} position={[0, 1.8, 0]}>
          <meshStandardMaterial color="#22c55e" emissive="#22c55e" emissiveIntensity={0.4} />
        </Sphere>
      )}

      {/* Violet charging beacon */}
      {isCharging && (
        <Sphere args={[0.35]} position={[0, 1.8, 0]}>
          <meshStandardMaterial color="#8b5cf6" emissive="#8b5cf6" emissiveIntensity={0.6} />
        </Sphere>
      )}
    </group>
  );
}
