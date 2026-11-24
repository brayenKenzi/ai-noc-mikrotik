/**
 * Tema Cafe Datacenter NOC Modern:
 * Perpaduan hangat lantai kayu cafe walnut & raised-floor datacenter bergaris cyan-amber,
 * bar kopi espresso, lampu gantung cafe hangat, deretan rak server 42U berkedip,
 * dan aliran partikel laporan agen NOC langsung menuju SPV NOC di tengah ruangan!
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
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
  SphereGeometry,
  Vector3,
} from 'three';
import { acak, buatKit, pelacak } from './alat';
import type { PembangunGaya } from './tipe';

const CYAN = '#38bdf8';
const AMBER = '#f59e0b';
const EMERALD = '#10b981';
const CAFE_FLOOR = '#1b1512';
const CAFE_WALL = '#121826';
const WALNUT = '#4c3222';
const WARM_WOOD = '#65432e';

export const datacenter: PembangunGaya = {
  buat: () => {
    const s = pelacak();
    const r = acak(88);
    const edgeCyan = s.simpan(new LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.32 }));
    const edgeAmber = s.simpan(new LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.42 }));
    const edgeEmerald = s.simpan(new LineBasicMaterial({ color: EMERALD, transparent: true, opacity: 0.55 }));

    return buatKit(s, {
      selaluMalam: true,
      warna: (c, p) => {
        if (p === 'lantai') return CAFE_FLOOR;
        if (p === 'karpet') return '#1c2436';
        if (p === 'garis') return '#2e241d';
        if (p === 'dinding') return CAFE_WALL;
        if (p === 'meja') return WALNUT;
        if (p === 'kayu') return WARM_WOOD;
        if (p === 'kursi') return '#201c26';
        if (p === 'sofa') return '#5b3722';
        return c;
      },
      bahan: (c, p) => {
        if (p === 'kaca') {
          return new MeshLambertMaterial({
            color: '#38bdf8',
            emissive: '#082f49',
            transparent: true,
            opacity: 0.2,
            side: DoubleSide,
          });
        }
        if (p === 'dinding') {
          return new MeshLambertMaterial({ color: CAFE_WALL, emissive: '#090d16' });
        }
        if (p === 'lantai' || p === 'karpet') {
          return new MeshLambertMaterial({
            color: p === 'karpet' ? '#172336' : CAFE_FLOOR,
            emissive: p === 'karpet' ? '#071324' : '#0a0705',
          });
        }
        if (p === 'meja' || p === 'kayu') {
          return new MeshLambertMaterial({ color: p === 'meja' ? WALNUT : WARM_WOOD, emissive: '#140b06', emissiveIntensity: 0.35 });
        }
        if (p === 'sofa') {
          return new MeshLambertMaterial({ color: '#6b3e26', emissive: '#1e0f07', emissiveIntensity: 0.3 });
        }
        if (p === 'papan') {
          return new MeshLambertMaterial({ color: '#071526', emissive: '#082f49', emissiveIntensity: 0.7 });
        }
        if (p === 'layar' || p === 'lampu' || p === 'catatan' || p === 'neon') {
          return new MeshLambertMaterial({ color: new Color(c).multiplyScalar(0.55), emissive: c });
        }
        if (p === 'baju' || p === 'kulit' || p === 'rambut' || p === 'celana') {
          return new MeshLambertMaterial({ color: c, emissive: '#080a10', emissiveIntensity: 0.25 });
        }
        return new MeshLambertMaterial({ color: c, emissive: '#090c14', emissiveIntensity: 0.3 });
      },
      hias: (m, p) => {
        if (p === 'papan') {
          m.add(new LineSegments(s.simpan(new EdgesGeometry(m.geometry)), edgeCyan));
        } else if (p === 'meja') {
          m.add(new LineSegments(s.simpan(new EdgesGeometry(m.geometry, 35)), edgeAmber));
        }
      },
      agen: { kepala: 1.05, badan: 1.0 },
      cahaya: { langit: '#fde68a', bumi: '#0f172a', kuat: 1.32, matahari: '#fff7ed', mKuat: 0.98 },
      kabut: ['#070b14', '#070b14'],
      dunia: ({ kantor, pasang }) => {
        const Y = -0.65;

        // Subtle hybrid datacenter + cafe grid
        const innerGrid = new GridHelper(14, 28, '#284b6e', '#172538');
        innerGrid.position.set(0, 0.018, -0.25);
        const outerGrid = new GridHelper(90, 45, '#0f2540', '#081322');
        outerGrid.position.y = Y - 0.02;
        kantor.add(innerGrid, outerGrid);
        for (const g of [innerGrid, outerGrid]) {
          (g.material as LineBasicMaterial).transparent = true;
          (g.material as LineBasicMaterial).opacity = g === innerGrid ? 0.32 : 0.35;
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
          s.simpan(new MeshBasicMaterial({ color: '#050810' })),
          0,
          Y - 0.04,
          0,
        ).rotation.x = -Math.PI / 2;

        // Warm amber & cyan perimeter cafe-datacenter floor LED strip
        const stripAmberMat = s.simpan(new MeshBasicMaterial({ color: '#f59e0b' }));
        const stripCyanMat = s.simpan(new MeshBasicMaterial({ color: '#38bdf8' }));
        pasang(s.simpan(new BoxGeometry(13.6, 0.02, 0.05)), stripCyanMat, 0, 0.02, -3.38);
        pasang(s.simpan(new BoxGeometry(13.6, 0.02, 0.05)), stripAmberMat, 0, 0.02, 2.92);

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

        // Datacenter Glass Rack Wall along the back & right side
        buildRack(-6.35, -3.02, 0);
        buildRack(-5.25, -3.02, 0);
        buildRack(-2.55, -3.02, 0);
        buildRack(2.75, -3.02, 0);
        buildRack(5.35, -3.02, 0);
        buildRack(6.42, -3.02, 0);
        buildRack(6.55, -0.5, -Math.PI / 2);
        buildRack(6.55, 0.65, -Math.PI / 2);

        // ---------- Artisan Cafe Espresso Bar Counter (Front-Left Lounge Zone) ----------
        const walnutMat = s.simpan(new MeshLambertMaterial({ color: '#5c3a21', emissive: '#1c0f06', emissiveIntensity: 0.35 }));
        const barTopMat = s.simpan(new MeshLambertMaterial({ color: '#85583a', emissive: '#1e1007', emissiveIntensity: 0.3 }));
        const chromeMat = s.simpan(new MeshLambertMaterial({ color: '#cbd5e1', emissive: '#1e293b', emissiveIntensity: 0.25 }));
        const warmBulbMat = s.simpan(new MeshBasicMaterial({ color: '#fde68a' }));
        const darkMetalMat = s.simpan(new MeshLambertMaterial({ color: '#1e293b' }));
        const pastryGlassMat = s.simpan(
          new MeshLambertMaterial({ color: '#fef3c7', emissive: '#78350f', transparent: true, opacity: 0.38 }),
        );

        // Espresso Bar at (-1.55, 2.38)
        const barBody = pasang(s.simpan(new BoxGeometry(2.1, 0.92, 0.56)), walnutMat, -1.55, 0.46, 2.38);
        barBody.add(new LineSegments(s.simpan(new EdgesGeometry(barBody.geometry)), edgeAmber));
        pasang(s.simpan(new BoxGeometry(2.22, 0.06, 0.66)), barTopMat, -1.55, 0.95, 2.38);
        // Glowing amber bar under-strip
        pasang(s.simpan(new BoxGeometry(2.05, 0.04, 0.02)), stripAmberMat, -1.55, 0.88, 2.08);
        // Dual-group Chrome Espresso Machine + Coffee Grinder
        pasang(s.simpan(new BoxGeometry(0.46, 0.38, 0.34)), chromeMat, -2.08, 1.17, 2.42);
        pasang(s.simpan(new BoxGeometry(0.16, 0.28, 0.16)), darkMetalMat, -1.55, 1.12, 2.42);
        // Pastry Glass Display Case with warm glow
        pasang(s.simpan(new BoxGeometry(0.56, 0.3, 0.36)), pastryGlassMat, -0.92, 1.13, 2.38);
        // 2 Cafe Bar Stools in front of Espresso Bar
        const stoolSeatGeo = s.simpan(new CylinderGeometry(0.18, 0.18, 0.06, 14));
        const stoolLegGeo = s.simpan(new CylinderGeometry(0.035, 0.04, 0.62, 10));
        for (const sx of [-2.0, -1.1]) {
          pasang(stoolSeatGeo, walnutMat, sx, 0.64, 1.72);
          pasang(stoolLegGeo, darkMetalMat, sx, 0.31, 1.72);
        }

        // Warm Cafe Edison Pendant Globes hanging over pods & Espresso Bar
        const bulbGeo = s.simpan(new SphereGeometry(0.11, 12, 10));
        const cordGeo = s.simpan(new BoxGeometry(0.018, 0.68, 0.018));
        for (const [bx, bz] of [
          [-4.35, -0.15],
          [0.0, 0.55],
          [4.25, -0.55],
          [-1.55, 2.35],
        ] as const) {
          pasang(cordGeo, darkMetalMat, bx, 3.05, bz);
          pasang(bulbGeo, warmBulbMat, bx, 2.68, bz);
        }

        // Overhead datacenter fiber cable trays (framing the Cafe ceiling)
        const trayMat = s.simpan(new MeshLambertMaterial({ color: '#1e293b', emissive: '#0c4a6e', emissiveIntensity: 0.45 }));
        const fiberMat = s.simpan(new MeshBasicMaterial({ color: '#38bdf8' }));
        const trayMain = pasang(s.simpan(new BoxGeometry(13.2, 0.08, 0.26)), trayMat, 0, 3.02, -2.55);
        pasang(s.simpan(new BoxGeometry(13.0, 0.03, 0.08)), fiberMat, 0, 3.08, -2.55);
        trayMain.add(new LineSegments(s.simpan(new EdgesGeometry(trayMain.geometry)), edgeCyan));

        // Animated telemetry light packets flowing FROM all 9 NOC Agents -> SPV NOC -> NOC Video Wall!
        const N = 135;
        const pGeo = s.simpan(new BufferGeometry());
        const pArr = new Float32Array(N * 3);
        pGeo.setAttribute('position', new Float32BufferAttribute(pArr, 3));
        const pts = new Points(
          pGeo,
          s.simpan(
            new PointsMaterial({
              color: '#fbbf24',
              size: 0.085,
              transparent: true,
              opacity: 0.88,
              depthWrite: false,
              blending: AdditiveBlending,
            }),
          ),
        );
        pts.frustumCulled = false;
        kantor.add(pts);
        s.simpan({ dispose: () => pts.removeFromParent() });

        const spvHub = new Vector3(0.0, 1.35, 0.55);
        const videoWall = new Vector3(0.0, 1.85, -3.25);
        const origins = [
          new Vector3(-5.3, 1.15, -1.75),
          new Vector3(-3.3, 1.15, -1.75),
          new Vector3(-4.35, 1.15, -0.15),
          new Vector3(-5.3, 1.15, 1.45),
          new Vector3(-3.3, 1.15, 1.45),
          new Vector3(0.0, 1.15, -1.75),
          new Vector3(3.3, 1.15, -1.65),
          new Vector3(5.2, 1.15, -1.65),
          new Vector3(4.25, 1.15, 0.35),
          spvHub, // Last lane: SPV NOC -> Giant Video Wall
        ];
        const phases = Array.from({ length: N }, () => r());
        const lanes = Array.from({ length: N }, (_, idx) => idx % origins.length);
        const tmp = new Vector3();

        pts.onBeforeRender = () => {
          const t = performance.now() / 1000;
          for (let i = 0; i < N; i++) {
            const lane = lanes[i]!;
            const src = origins[lane]!;
            const dst = lane === origins.length - 1 ? videoWall : spvHub;
            const u = (t * 0.3 + phases[i]!) % 1;
            tmp.lerpVectors(src, dst, u);
            tmp.y += Math.sin(u * Math.PI) * (lane === origins.length - 1 ? 0.9 : 0.72);
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
