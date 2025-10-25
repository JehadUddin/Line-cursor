import React, { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * Interface for a point with x and y coordinates.
 */
interface Point {
  x: number;
  y: number;
}

/**
 * Interface for a physics point with position and velocity.
 */
interface PhysicsPoint {
    pos: THREE.Vector3;
    vel: THREE.Vector3;
}


const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = `
  uniform vec3 color1;
  uniform vec3 color2;
  uniform vec3 color3;
  varying vec2 vUv;

  void main() {
    // Tapered alpha
    float alpha = sin(vUv.x * 3.14159);

    // 3-color gradient
    vec3 color = mix(color1, color2, smoothstep(0.0, 0.6, vUv.x));
    color = mix(color, color3, smoothstep(0.5, 1.0, vUv.x));
    
    gl_FragColor = vec4(color, alpha);
  }
`;

const colorPalettes = [
    { c1: new THREE.Color(0x48007d), c2: new THREE.Color(0xc13584), c3: new THREE.Color(0xfd8d32) }, // Purple -> Pink -> Orange
    { c1: new THREE.Color(0x00416a), c2: new THREE.Color(0x799f0c), c3: new THREE.Color(0xffe000) }, // Dark Blue -> Green -> Yellow
    { c1: new THREE.Color(0x1d2b64), c2: new THREE.Color(0xf8cdda), c3: new THREE.Color(0xffffff) }, // Navy -> Light Pink -> White
];

// --- Configuration Tokens ---
const config = {
  strands: {
    count: 1,
  },
  trail: {
    length: 20,
  },
  physics: {
    stiffness: 0.2,
    damping: 0.65,
    internalStiffness: 0.1,
    restLength: 0.01,
  },
  interaction: {
    idleTimeout: 1000, // ms
    maxVelocity: 50,
  },
  animation: {
    idle: {
      pulseInterval: 1000, // ms
      pulseDuration: 1500, // ms
      pulseMaxRadius: 0.5,
    }
  },
  rendering: {
    bloom: {
      strength: 1.5,
      radius: 0.6,
      threshold: 0,
    },
    tube: {
      radiusMin: 0.004,
      radiusMax: 0.008,
      tubularSegments: 64,
      radialSegments: 8,
    }
  }
};


const App: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const tubeMeshesRef = useRef<THREE.Mesh[]>([]);
    const materialsRef = useRef<THREE.ShaderMaterial[]>([]);
    const composerRef = useRef<EffectComposer | null>(null);
    const mousePosRef = useRef<Point>({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const lastMousePosRef = useRef<Point>({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const mouseVelocityRef = useRef(0);
    const idleTimerRef = useRef<number | null>(null);
    const isIdleRef = useRef(true);
    const isOutsideRef = useRef(false);
    const visibilityRef = useRef(1);

    const initialPoint = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const targetPathsRef = useRef<Point[][]>(
        Array.from({ length: config.strands.count }, () =>
            Array(config.trail.length).fill(initialPoint)
        )
    );

    const physicsPathsRef = useRef<PhysicsPoint[][]>(
        Array.from({ length: config.strands.count }, () => 
            Array.from({ length: config.trail.length }, () => ({
                pos: new THREE.Vector3(0, 0, 0),
                vel: new THREE.Vector3(0, 0, 0),
            }))
        )
    );
    
    // Refs for idle pulse animation
    const pulsesRef = useRef<{ startTime: number; position: THREE.Vector3 }[]>([]);
    const pulseMeshesRef = useRef<THREE.Mesh[]>([]);
    const lastPulseTimeRef = useRef(0);
    const pulseGeometryRef = useRef<THREE.RingGeometry | null>(null);
    const pulseMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null);

    const [colorIndex, setColorIndex] = useState(0);

    useEffect(() => {
        if (!canvasRef.current) return;

        const scene = new THREE.Scene();
        sceneRef.current = scene;
        const sizes = { width: window.innerWidth, height: window.innerHeight };
        const camera = new THREE.PerspectiveCamera(75, sizes.width / sizes.height, 0.1, 100);
        camera.position.z = 2;
        scene.add(camera);

        const renderer = new THREE.WebGLRenderer({ 
            canvas: canvasRef.current, 
            antialias: true,
            alpha: true 
        });
        renderer.setSize(sizes.width, sizes.height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        const renderScene = new RenderPass(scene, camera);
        const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
        bloomPass.threshold = config.rendering.bloom.threshold;
        bloomPass.strength = config.rendering.bloom.strength;
        bloomPass.radius = config.rendering.bloom.radius;

        const composer = new EffectComposer(renderer);
        composer.addPass(renderScene);
        composer.addPass(bloomPass);
        composerRef.current = composer;

        materialsRef.current = Array.from({ length: config.strands.count }, (_, i) => {
            const palette = colorPalettes[(i + colorIndex) % colorPalettes.length];
            return new THREE.ShaderMaterial({
                vertexShader,
                fragmentShader,
                uniforms: {
                    color1: { value: palette.c1 },
                    color2: { value: palette.c2 },
                    color3: { value: palette.c3 },
                },
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            });
        });

        // Setup for idle pulse animation
        pulseGeometryRef.current = new THREE.RingGeometry(0.001, 0.002, 32);
        pulseMaterialRef.current = new THREE.MeshBasicMaterial({
            color: colorPalettes[colorIndex].c2,
            transparent: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        
        let vFOV = THREE.MathUtils.degToRad(camera.fov);
        let height = 2 * Math.tan(vFOV / 2) * camera.position.z;
        let width = height * camera.aspect;

        const handleMouseMove = (event: MouseEvent) => {
            if (isIdleRef.current) isIdleRef.current = false;
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
            idleTimerRef.current = window.setTimeout(() => {
                isIdleRef.current = true;
            }, config.interaction.idleTimeout);
            mousePosRef.current = { x: event.clientX, y: event.clientY };
        };
        
        const handleMouseOut = () => {
            isOutsideRef.current = true;
        };

        const handleMouseEnter = (event: MouseEvent) => {
            isOutsideRef.current = false;
            const newPoint = { x: event.clientX, y: event.clientY };
            mousePosRef.current = newPoint;
            lastMousePosRef.current = newPoint;
            targetPathsRef.current[0] = Array(config.trail.length).fill(newPoint);

            const targetPos = new THREE.Vector3(
                (newPoint.x / sizes.width - 0.5) * width,
                -(newPoint.y / sizes.height - 0.5) * height,
                0
            );
            physicsPathsRef.current[0] = Array.from({ length: config.trail.length }, () => ({
                pos: targetPos.clone(),
                vel: new THREE.Vector3(0, 0, 0),
            }));
        };

        window.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseout', handleMouseOut);
        document.addEventListener('mouseenter', handleMouseEnter);

        const tick = () => {
            const time = Date.now();
            
            // 1. Update visibility
            const targetVisibility = isOutsideRef.current ? 0 : 1;
            visibilityRef.current = THREE.MathUtils.lerp(visibilityRef.current, targetVisibility, 0.1);

            // 2. Update Mouse Velocity
            const dx = mousePosRef.current.x - lastMousePosRef.current.x;
            const dy = mousePosRef.current.y - lastMousePosRef.current.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            mouseVelocityRef.current = THREE.MathUtils.lerp(mouseVelocityRef.current, dist, 0.1);
            lastMousePosRef.current = { ...mousePosRef.current };

            // 3. Update Target Paths and Handle Idle Animation
            const idleConfig = config.animation.idle;
            if (isIdleRef.current) {
                // Collapse the trail to the last point by modifying the array in-place
                const path = targetPathsRef.current[0];
                if (path && path.length > 0) {
                    const lastPoint = path[path.length - 1];
                    if (lastPoint) {
                        for (let i = 0; i < path.length; i++) {
                            path[i] = lastPoint;
                        }
                    }
                }

                // Create new pulses
                if (visibilityRef.current > 0.9) {
                    const now = Date.now();
                    if (now - lastPulseTimeRef.current > idleConfig.pulseInterval) {
                        lastPulseTimeRef.current = now;
                        const headPosition = physicsPathsRef.current[0][config.trail.length - 1].pos;
                        pulsesRef.current.push({
                            startTime: now,
                            position: headPosition.clone(),
                        });
                    }
                }
            } else {
                // Update the path in-place to avoid race conditions
                const path = targetPathsRef.current[0];
                const newPoint = mousePosRef.current;
                if (path) {
                    path.shift();
                    path.push(newPoint);
                }
            }

            // 4. Run Physics Simulation
            physicsPathsRef.current.forEach((physicsPath, strandIndex) => {
                const targetPath = targetPathsRef.current[strandIndex];
                physicsPath.forEach((physicsPoint, pointIndex) => {
                    const targetPoint = targetPath[pointIndex];
                    if (!targetPoint) return;
                    
                    const targetPos = new THREE.Vector3(
                        (targetPoint.x / window.innerWidth - 0.5) * width,
                        -(targetPoint.y / window.innerHeight - 0.5) * height,
                        0
                    );
                    const force = targetPos.clone().sub(physicsPoint.pos).multiplyScalar(config.physics.stiffness);
                    
                    if (pointIndex > 0) {
                        const prevPoint = physicsPath[pointIndex - 1];
                        const delta = physicsPoint.pos.clone().sub(prevPoint.pos);
                        const dist = delta.length();
                        const springForce = delta.normalize().multiplyScalar(dist - config.physics.restLength).multiplyScalar(-config.physics.internalStiffness);
                        force.add(springForce);
                    }
                     if (pointIndex < physicsPath.length - 1) {
                        const nextPoint = physicsPath[pointIndex + 1];
                        const delta = physicsPoint.pos.clone().sub(nextPoint.pos);
                        const dist = delta.length();
                        const springForce = delta.normalize().multiplyScalar(dist - config.physics.restLength).multiplyScalar(-config.physics.internalStiffness);
                        force.add(springForce);
                    }

                    const damping = physicsPoint.vel.clone().multiplyScalar(-config.physics.damping);
                    physicsPoint.vel.add(force).add(damping);
                    physicsPoint.pos.add(physicsPoint.vel);
                });
            });

            // 5. Update Renderable Geometries
            tubeMeshesRef.current.forEach(mesh => { scene.remove(mesh); mesh.geometry.dispose(); });
            tubeMeshesRef.current = [];

            if (visibilityRef.current > 0.01) {
                const velocityFactor = Math.min(mouseVelocityRef.current / config.interaction.maxVelocity, 1);
                const tubeRadius = THREE.MathUtils.lerp(config.rendering.tube.radiusMax, config.rendering.tube.radiusMin, velocityFactor);

                physicsPathsRef.current.forEach((path, i) => {
                    const points = path.map(p => p.pos);
                    if (points.length < 2) return;

                    const tubeConfig = config.rendering.tube;
                    const curve = new THREE.CatmullRomCurve3(points);
                    const geometry = new THREE.TubeGeometry(curve, tubeConfig.tubularSegments, tubeRadius * visibilityRef.current, tubeConfig.radialSegments, false);
                    const material = materialsRef.current[i];
                    
                    if (material) {
                        const newTubeMesh = new THREE.Mesh(geometry, material);
                        scene.add(newTubeMesh);
                        tubeMeshesRef.current.push(newTubeMesh);
                    }
                });
            }
            
            // 6. Update Idle Pulses
            const now = Date.now();
            pulsesRef.current = pulsesRef.current.filter(p => now - p.startTime < idleConfig.pulseDuration);
            
            while (pulseMeshesRef.current.length < pulsesRef.current.length) {
                if (pulseGeometryRef.current && pulseMaterialRef.current) {
                    const newMesh = new THREE.Mesh(pulseGeometryRef.current, pulseMaterialRef.current);
                    scene.add(newMesh);
                    pulseMeshesRef.current.push(newMesh);
                }
            }
            while (pulseMeshesRef.current.length > pulsesRef.current.length) {
                const oldMesh = pulseMeshesRef.current.pop();
                if (oldMesh) scene.remove(oldMesh);
            }

            pulsesRef.current.forEach((pulse, index) => {
                const mesh = pulseMeshesRef.current[index];
                if (mesh) {
                    const age = now - pulse.startTime;
                    const progress = age / idleConfig.pulseDuration;
                    
                    mesh.position.copy(pulse.position);
                    const scale = 1.0 + (idleConfig.pulseMaxRadius * progress);
                    mesh.scale.set(scale, scale, scale);
                    
                    if (mesh.material instanceof THREE.MeshBasicMaterial) {
                        mesh.material.opacity = 1.0 - progress;
                    }
                }
            });

            composer.render();
            window.requestAnimationFrame(tick);
        };
        tick();

        const handleResize = () => {
            sizes.width = window.innerWidth;
            sizes.height = window.innerHeight;
            camera.aspect = sizes.width / sizes.height;
            camera.updateProjectionMatrix();

            vFOV = THREE.MathUtils.degToRad(camera.fov);
            height = 2 * Math.tan(vFOV / 2) * camera.position.z;
            width = height * camera.aspect;

            renderer.setSize(sizes.width, sizes.height);
            composer.setSize(sizes.width, sizes.height);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseout', handleMouseOut);
            document.removeEventListener('mouseenter', handleMouseEnter);
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
            pulseMeshesRef.current.forEach(mesh => sceneRef.current?.remove(mesh));
            pulseMeshesRef.current = [];
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const palette = colorPalettes[colorIndex % colorPalettes.length];
        if (materialsRef.current.length > 0) {
            materialsRef.current.forEach((material) => {
                material.uniforms.color1.value = palette.c1;
                material.uniforms.color2.value = palette.c2;
                material.uniforms.color3.value = palette.c3;
            });
        }
        if (pulseMaterialRef.current) {
            pulseMaterialRef.current.color.set(palette.c2);
        }
    }, [colorIndex]);

    const handleClick = () => {
        setColorIndex((prevIndex) => (prevIndex + 1) % colorPalettes.length);
    };

    return (
        <div className="w-screen h-screen bg-black text-gray-100 font-sans cursor-none overflow-hidden" onClick={handleClick}>
            <canvas
                ref={canvasRef}
                className="fixed top-0 left-0 outline-none"
            />
        </div>
    );
};

export default App;
