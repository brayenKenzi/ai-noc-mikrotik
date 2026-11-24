/**
 * Tema Datacenter NOC Modern:
 * Lantai raised-floor gelap bergaris tray fiber cyan, deretan rak server 42U dengan LED status berkedip,
 * kabel overhead, dinding video wall NOC, dan partikel telemetri real-time.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import { acak, buatKit, pelacak } from './alat';
import type { PembangunGaya } from './tipe';

const CYAN = '#38bdf8';
const EMERALD = '#10b981';
const SLATE_FLOOR = '#0b1324';
const SLATE_WALL = '#101a30';

export const datacenter: PembangunGaya = {
  buat: () => {
    const s = pelacak();
    const r = acak(88);
    const edgeCyan = s.simpan(new LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.35 }));
    const edgeEmerald = s.simpan(new LineBasicMaterial({ color: EMERALD, transparent: true, opacity: 0.55 }));

    return buatKit(s, {
      selaluMalam: true,
      warna: (c, p) => {
        if (p === 'lantai') return SLATE_FLOOR;
        if (p === 'karpet') return '#0f213a';
        if (p === 'garis') return '#1e3a5f';
        if (p === 'dinding') return SLATE_WALL;
        if (p === 'meja') return '#1a2438';
        if (p === 'kayu') return '#1e293b';
        if (p === 'kursi') return '#172033';
        if (p === 'sofa') return '#1e293b';
        return c;
      },
      bahan: (c, p) => {
        if (p === 'kaca') {
          return new MeshLambertMaterial({
            color: '#0ea5e9',
            emissive: '#082f49',
            transparent: true,
            opacity: 0.18,
            side: DoubleSide,
          });
        }
        if (p === 'dinding') {
          return new MeshLambertMaterial({ color: SLATE_WALL, emissive: '#070d1c' });
        }
        if (p === 'lantai' || p === 'karpet') {
          return new MeshLambertMaterial({
            color: p === 'karpet' ? '#0f223d' : SLATE_FLOOR,
            emissive: '#040914',
          });
        }
        if (p === 'papan') {
          return new MeshLambertMaterial({ color: '#071526', emissive: '#082f49', emissiveIntensity: 0.7 });
        }
        if (p === 'layar' || p === 'lampu' || p === 'catatan' || p === 'neon') {
          return new MeshLambertMaterial({ color: new Color(c).multiplyScalar(0.55), emissive: c });
        }
        if (p === 'baju' || p === 'kulit' || p === 'rambut' || p === 'celana') {
          return new MeshLambertMaterial({ color: c, emissive: '#050812', emissiveIntensity: 0.25 });
        }
        return new MeshLambertMaterial({ color: c, emissive: '#070d1b', emissiveIntensity: 0.3 });
      },
      hias: (m, p) => {
        if (p === 'papan') {
          m.add(new LineSegments(s.simpan(new EdgesGeometry(m.geometry)), edgeCyan));
        } else if (p === 'meja') {
          m.add(new LineSegments(s.simpan(new EdgesGeometry(m.geometry, 35)), edgeCyan));
        }
      },
      agen: { kepala: 1.05, badan: 1.0 },
      cahaya: { langit: '#93c5fd', bumi: '#0b1120', kuat: 1.25, matahari: '#e0f2fe', mKuat: 0.95 },
      kabut: ['#050a14', '#050a14'],
      dunia: ({ kantor, pasang }) => {
        const Y = -0.65;

        // Raised-floor datacenter grid inside + subtle extended floor outside
        const innerGrid = new GridHelper(14, 28, '#1e4e79', '#0f2540');
        innerGrid.position.set(0, 0.02, -0.25);
        const outerGrid = new GridHelper(90, 45, '#0b2540', '#071526');
        outerGrid.position.y = Y - 0.02;
        kantor.add(innerGrid, outerGrid);
        for (const g of [innerGrid, outerGrid]) {
          (g.material as LineBasicMaterial).transparent = true;
          (g.material as LineBasicMaterial).opacity = g === innerGrid ? 0.55 : 0.4;
          s.simpan({
            dispose: () => {
              g.geometry.dispose();
              (g.material as LineBasicMaterial).dispose();
              g.removeFromParent();
            },
          });
        }
        pasang(
          s.simpan(new PlaneGeometry(120, 120)),
          s.simpan(new MeshBasicMaterial({ color: '#040812' })),
          0,
          Y - 0.04,
          0,
        ).rotation.x = -Math.PI / 2;

        // ---------- 42U Server Racks with animated blinking blade LEDs ----------
        const rackBodyGeo = s.simpan(new BoxGeometry(0.95, 2.35, 0.72));
        const rackBladeGeo = s.simpan(new BoxGeometry(0.82, 0.14, 0.04));
        const ledGeo = s.simpan(new BoxGeometry(0.055, 0.04, 0.02));
        const rackMat = s.simpan(new MeshLambertMaterial({ color: '#0f172a', emissive: '#050b16' }));
        const bladeMat = s.simpan(new MeshLambertMaterial({ color: '#1e293b', emissive: '#0a1426' }));
        const ledMats = [
          s.simpan(new MeshBasicMaterial({ color: '#22c55e' })),
          s.simpan(new MeshBasicMaterial({ color: '#38bdf8' })),
          s.simpan(new MeshBasicMaterial({ color: '#f59e0b' })),
          s.simpan(new MeshBasicMaterial({ color: '#0ea5e9' })),
        ];
        const ledMeshes: { mesh: Mesh; phase: number; speed: number }[] = [];

        const buildRack = (x: number, z: number, rotY = 0) => {
          const g = new Group();
          const body = new Mesh(rackBodyGeo, rackMat);
          body.position.set(0, 1.18, 0);
          body.add(new LineSegments(s.simpan(new EdgesGeometry(rackBodyGeo)), edgeEmerald));
          g.add(body);

          for (let u = 0; u < 9; u++) {
            const y = 0.3 + u * 0.21;
            const blade = new Mesh(rackBladeGeo, bladeMat);
            blade.position.set(0, y, 0.365);
            g.add(blade);

            for (let b = 0; b < 3; b++) {
              const lm = ledMats[(u + b) % ledMats.length]!;
              const led = new Mesh(ledGeo, lm);
              led.position.set(-0.3 + b * 0.11, y, 0.39);
              g.add(led);
              ledMeshes.push({ mesh: led, phase: r() * Math.PI * 2, speed: 3 + r() * 8 });
            }
          }
          g.position.set(x, 0, z);
          g.rotation.y = rotY;
          kantor.add(g);
          s.simpan({ dispose: () => g.removeFromParent() });
        };

        // Back-left & back-right server rack rows (clear of desks and doorways)
        buildRack(-6.35, -3.02, 0);
        buildRack(-5.25, -3.02, 0);
        buildRack(-2.55, -3.02, 0);
        buildRack(2.75, -3.02, 0);
        buildRack(5.35, -3.02, 0);
        buildRack(6.42, -3.02, 0);
        // Side wall network core rack
        buildRack(6.55, -0.5, -Math.PI / 2);
        buildRack(6.55, 0.65, -Math.PI / 2);

        // Overhead datacenter fiber cable trays
        const trayMat = s.simpan(new MeshLambertMaterial({ color: '#1e293b', emissive: '#0c4a6e', emissiveIntensity: 0.45 }));
        const fiberMat = s.simpan(new MeshBasicMaterial({ color: '#38bdf8' }));
        const trayMain = pasang(s.simpan(new BoxGeometry(13.2, 0.08, 0.28)), trayMat, 0, 2.95, -2.5);
        const fiberStrip = pasang(s.simpan(new BoxGeometry(13.0, 0.03, 0.08)), fiberMat, 0, 3.01, -2.5);
        trayMain.add(new LineSegments(s.simpan(new EdgesGeometry(trayMain.geometry)), edgeCyan));
        void fiberStrip;

        // Animated fiber-optic telemetry particles flowing to NOC Video Wall
        const N = 120;
        const pGeo = s.simpan(new BufferGeometry());
        const pArr = new Float32Array(N * 3);
        pGeo.setAttribute('position', new Float32BufferAttribute(pArr, 3));
        const pts = new Points(
          pGeo,
          s.simpan(
            new PointsMaterial({
              color: '#38bdf8',
              size: 0.085,
              transparent: true,
              opacity: 0.85,
              depthWrite: false,
              blending: AdditiveBlending,
            }),
          ),
        );
        pts.frustumCulled = false;
        kantor.add(pts);
        s.simpan({ dispose: () => pts.removeFromParent() });

        const board = new Vector3(0.1, 1.85, -3.25);
        const origins = [
          new Vector3(-5.75, 1.2, -1.85),
          new Vector3(-3.15, 1.2, -1.85),
          new Vector3(-4.45, 1.2, -0.15),
          new Vector3(-5.75, 1.2, 1.45),
          new Vector3(-3.15, 1.2, 1.45),
          new Vector3(0.1, 1.2, -0.3),
          new Vector3(3.4, 1.2, -1.5),
          new Vector3(5.6, 1.2, -1.5),
          new Vector3(4.5, 1.2, 1.0),
        ];
        const phases = Array.from({ length: N }, () => r());
        const lanes = Array.from({ length: N }, (_, idx) => idx % origins.length);
        const tmp = new Vector3();

        pts.onBeforeRender = () => {
          const t = performance.now() / 1000;
          for (let i = 0; i < N; i++) {
            const src = origins[lanes[i]!]!;
            const u = (t * 0.26 + phases[i]!) % 1;
            tmp.lerpVectors(src, board, u);
            tmp.y += Math.sin(u * Math.PI) * 1.15;
            pArr[i * 3] = tmp.x;
            pArr[i * 3 + 1] = tmp.y;
            pArr[i * 3 + 2] = tmp.z;
          }
          pGeo.attributes.position!.needsUpdate = true;

          // Blink server rack LEDs
          for (const item of ledMeshes) {
            item.mesh.visible = Math.sin(t * item.speed + item.phase) > -0.35;
          }
        };

        return { gantiLuar: true, lebar: 1.05 };
      },
    });
  },
};
