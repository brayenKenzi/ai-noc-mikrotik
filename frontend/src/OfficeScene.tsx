import { useEffect, useRef } from 'react';
import {
  AmbientLight,
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Material,
  type BufferGeometry,
  OrthographicCamera,
  PlaneGeometry,
  PointLight,
  QuadraticBezierCurve3,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RUANGAN } from './config';
import { buatKitGaya } from './gaya';
import type { Dunia, Peran } from './gaya/alat';
import type { DeskState } from './office';
import type { LiveTopologyLink } from './nocLive';
import {
  createPingMonitorController,
  createVideoWallController,
  type ExternalPingFeed,
  type MonitorPingFeed,
  type MonitorScreenController,
} from './pingScreenTexture';

type AgentKey = string;

export interface CameraControlApi {
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
  focusAgent: (key: string) => void;
}

export interface SceneProps {
  desks: readonly DeskState[];
  pingFeeds?: readonly MonitorPingFeed[];
  externalPings?: readonly ExternalPingFeed[];
  topologyLinks?: readonly LiveTopologyLink[];
  activeAlerts?: number;
  night: boolean;
  boardCount: number;
  anchors: React.RefObject<Map<AgentKey, HTMLElement>>;
  boardAnchor: React.RefObject<HTMLElement | null>;
  cameraApi?: React.RefObject<CameraControlApi | null>;
  autoTour?: boolean;
  cinematic?: boolean;
  manual?: boolean;
  drive?: React.RefObject<((t: number) => void) | null>;
  onReady?: () => void;
  onFail?: () => void;
  gaya?: string;
}

const shade = (hex: string, f: number) => {
  const c = new Color(hex);
  c.multiplyScalar(f);
  return `#${c.getHexString()}`;
};
const ROOMS = RUANGAN.map((r) => ({ x0: r.x0, x1: r.x1, floor: r.warna, floorNight: shade(r.warna, 0.32), rug: r.karpet }));
const Z0 = -3.5;
const Z1 = 3;
const SKIN = ['#f1c7a5', '#d9a07b', '#c68863', '#e8b896', '#b97a56', '#f0c09c', '#dfb18c', '#c98e68'];
const HAIR = ['#1f1612', '#141122', '#4a2e1d', '#1b1628', '#5c3820', '#181326', '#2a1d17', '#101420'];
const BOARD = new Vector3(0.1, 0, -2.5);

type LifeMode = 'kerja' | 'minum' | 'istirahat' | 'ngobrol' | 'rak';

interface Actor {
  key: AgentKey;
  nama: string;
  isSupervisor: boolean;
  root: Group;
  body: Mesh;
  head: Mesh;
  armL: Mesh;
  armR: Mesh;
  legL: Mesh;
  legR: Mesh;
  cup: Mesh;
  screen: Mesh;
  screen2: Mesh;
  screenCtrl: MonitorScreenController;
  deskTop: Mesh;
  book: Mesh;
  lamp: Mesh;
  light: PointLight | null;
  seat: Vector3;
  label: Vector3;
  phase: number;
  index: number;
}

const LIFE_MODES: readonly LifeMode[] = ['minum', 'istirahat', 'ngobrol', 'rak'];

function easeSmooth(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/**
 * Autonomous staggered life cycle so healthy IT agents work at their monitors most of the time,
 * while 2-3 agents organically get up to grab coffee, rest on the sofa, chat with colleagues, or inspect server racks.
 */
function agentLifeAt(index: number, t: number): {
  mode: LifeMode;
  k: number;
  walking: boolean;
  going: boolean;
  peerOffset: number;
} {
  const cycleLen = 72;
  const shifted = t + index * 11.7;
  const cycleNum = Math.floor(shifted / cycleLen);
  const localT = ((shifted % cycleLen) + cycleLen) % cycleLen;

  // 0..46s: focused at workstation typing & monitoring
  if (localT < 46) {
    return { mode: 'kerja', k: 0, walking: false, going: false, peerOffset: 1 };
  }

  const mode = LIFE_MODES[(cycleNum + index) % LIFE_MODES.length]!;
  const peerOffset = 1 + ((cycleNum + index) % 3);
  const actT = localT - 46; // 0..26s

  if (actT < 4.0) {
    return { mode, k: easeSmooth(actT / 4.0), walking: true, going: true, peerOffset };
  }
  if (actT < 22.0) {
    return { mode, k: 1, walking: false, going: false, peerOffset };
  }
  return { mode, k: 1 - easeSmooth((actT - 22.0) / 4.0), walking: true, going: false, peerOffset };
}

export default function OfficeScene({
  desks,
  pingFeeds = [],
  externalPings = [],
  topologyLinks = [],
  activeAlerts = 0,
  night,
  boardCount,
  anchors,
  boardAnchor,
  cameraApi,
  autoTour = false,
  cinematic,
  manual,
  drive,
  onReady,
  onFail,
  gaya,
}: SceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({
    desks,
    pingFeeds,
    externalPings,
    topologyLinks,
    activeAlerts,
    night,
    boardCount,
    autoTour,
    dirty: true,
  });
  live.current = {
    desks,
    pingFeeds,
    externalPings,
    topologyLinks,
    activeAlerts,
    night,
    boardCount,
    autoTour,
    dirty: true,
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: WebGLRenderer;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    try {
      renderer = new WebGLRenderer({
        antialias: !touch || !!manual,
        alpha: true,
        powerPreference: manual ? 'high-performance' : 'low-power',
        preserveDrawingBuffer: !!manual,
      });
    } catch {
      onFail?.();
      return;
    }
    renderer.setPixelRatio(manual ? 1 : Math.min(window.devicePixelRatio || 1, touch ? 1.5 : 2));
    renderer.domElement.style.touchAction = 'none';
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', 'Kantor AI NOC 3D — Drag untuk putar, scroll/pinch untuk zoom');

    const scene = new Scene();
    const K = buatKitGaya(gaya);
    if (cinematic && K.kabut) scene.fog = new Fog(K.kabut[0], 34, 58);
    const kantor = new Group();
    scene.add(kantor);
    const camera = new OrthographicCamera(-10, 10, 6, -6, 0.1, 140);
    const target = new Vector3(0, 1.0, -0.2);

    const C = K.cahaya;
    const hemi = new HemisphereLight(C.langit, C.bumi, C.kuat);
    const sun = new DirectionalLight(C.matahari, C.mKuat);
    sun.position.set(-6, 14, 9);
    const fillLight = new DirectionalLight('#38bdf8', 0.35);
    fillLight.position.set(8, 8, -6);
    const amb = new AmbientLight('#ffffff', 0.42);
    scene.add(hemi, sun, fillLight, amb);

    const disposables: { dispose(): void }[] = [];
    const geo = <T extends BufferGeometry>(g: T) => (disposables.push(g), g);
    const mat = (color: string, peran: Peran, emissive?: string) => K.bahan(color, peran, emissive);
    const peranDari = (m: Material) => (m.userData.peran ?? 'kayu') as Peran;
    const add = (mesh: Mesh, x: number, y: number, z: number, parent: Scene | Group | Mesh = kantor) => {
      mesh.position.set(x, y, z);
      parent.add(mesh);
      K.hias?.(mesh, peranDari(mesh.material as Material));
      return mesh;
    };
    const box = (w: number, h: number, d: number, m: Material, x: number, y: number, z: number, parent?: Group) =>
      add(new Mesh(K.kotak(w, h, d, peranDari(m)), m), x, y, z, parent);
    const cyl = (rt: number, rb: number, h: number, m: Material) => new Mesh(K.tabung(rt, rb, h, peranDari(m)), m);
    const ball = (r: number, m: Material, kubah = false) => new Mesh(K.bola(r, peranDari(m), kubah), m);
    const cone = (r: number, h: number, m: Material, open = false) => new Mesh(K.kerucut(r, h, peranDari(m), open), m);

    // ---------- the building ----------
    const lineM = mat('#cdb79c', 'garis');
    const floors = ROOMS.map((r) => {
      const m = mat(r.floor, 'lantai');
      box(r.x1 - r.x0 - 0.04, 0.14, Z1 - Z0, m, (r.x0 + r.x1) / 2, -0.07, (Z0 + Z1) / 2);
      for (let z = Z0 + 0.5; z < Z1; z += 0.65)
        box(r.x1 - r.x0 - 0.1, 0.005, 0.02, lineM, (r.x0 + r.x1) / 2, 0.002, z);
      box(2.6, 0.02, 1.8, mat(r.rug, 'karpet'), (r.x0 + r.x1) / 2, 0.012, 0.8);
      return { m, r };
    });
    box(14.6, 0.5, Z1 - Z0 + 0.6, mat('#1e293b', 'alas'), 0, -0.4, (Z0 + Z1) / 2 + 0.15);
    const wallM = mat('#fbf6ef', 'dinding');
    const wallSideM = mat('#f1e8dc', 'dinding');
    const trimM = mat('#1e293b', 'bingkai');
    const woodM = mat('#334155', 'kayu');
    box(14, 3, 0.18, wallM, 0, 1.5, Z0 - 0.09);
    box(0.18, 3, Z1 - Z0, wallSideM, -7.09, 1.5, (Z0 + Z1) / 2);
    box(14, 0.12, 0.22, woodM, 0, 0.06, Z0 - 0.02);
    box(0.22, 0.12, Z1 - Z0, woodM, -7.02, 0.06, (Z0 + Z1) / 2);
    // Open-concept Cafe Datacenter (no boxy cubicle walls — low accent zone rugs & brass/cyan floor trim)
    const glassM = mat('#bfe3ff', 'kaca', '#7fb8e6');
    for (const z of [-1.2, 1.4]) {
      box(0.06, 1.1, 1.4, trimM, -7.0, 1.8, z);
      box(0.04, 0.96, 1.26, glassM, -6.97, 1.8, z);
    }
    for (const r of ROOMS) box(1.8, 0.22, 0.04, mat(r.rug, 'catatan', r.rug), (r.x0 + r.x1) / 2, 2.75, Z0 + 0.03);

    // NOC Giant Live Ping Video Wall (Mission Board)
    const videoWallCtrl = createVideoWallController();
    disposables.push(videoWallCtrl);
    const videoWallMat = new MeshBasicMaterial({ map: videoWallCtrl.texture });
    disposables.push(videoWallMat);
    box(3.3, 1.5, 0.1, trimM, BOARD.x, 1.55, Z0 + 0.05);
    box(3.1, 1.3, 0.04, mat('#0f172a', 'papan'), BOARD.x, 1.55, Z0 + 0.11);
    const videoWallPlane = new Mesh(geo(new PlaneGeometry(3.04, 1.26)), videoWallMat);
    videoWallPlane.position.set(BOARD.x, 1.55, Z0 + 0.145);
    kantor.add(videoWallPlane);
    const notes: Mesh[] = [];

    // Illuminated ADT — Alazka Digital Tech Datacenter Brand Signboards (3:2 ratio)
    const adtTex = new TextureLoader().load('/adt-logo.png');
    adtTex.colorSpace = SRGBColorSpace;
    disposables.push(adtTex);
    const adtLogoMat = new MeshBasicMaterial({ map: adtTex });
    const adtGlowFrameM = new MeshBasicMaterial({ color: '#0ea5e9' });
    disposables.push(adtLogoMat, adtGlowFrameM);

    // Main illuminated ADT wall plaque above the NOC Video Wall
    box(1.76, 1.18, 0.08, trimM, BOARD.x, 2.98, Z0 + 0.04);
    box(1.68, 1.1, 0.09, adtGlowFrameM, BOARD.x, 2.98, Z0 + 0.045);
    const mainAdtSign = new Mesh(geo(new PlaneGeometry(1.62, 1.08)), adtLogoMat);
    mainAdtSign.position.set(BOARD.x, 2.98, Z0 + 0.1);
    kantor.add(mainAdtSign);

    // Secondary illuminated ADT plaque on the left Datacenter wall
    box(0.08, 1.08, 1.62, trimM, -6.96, 2.38, 0.1);
    box(0.09, 1.02, 1.54, adtGlowFrameM, -6.955, 2.38, 0.1);
    const sideAdtSign = new Mesh(geo(new PlaneGeometry(1.48, 0.98)), adtLogoMat);
    sideAdtSign.position.set(-6.9, 2.38, 0.1);
    sideAdtSign.rotation.y = Math.PI / 2;
    kantor.add(sideAdtSign);

    // ---------- Cafe Lounge Corner (Front-Right at x=4.35, z=2.35) + Bistro Table ----------
    box(2.05, 0.4, 0.68, mat('#6b3e26', 'sofa'), 4.35, 0.2, 2.38);
    box(2.05, 0.52, 0.16, mat('#4c2a18', 'sofa'), 4.35, 0.62, 2.7);
    box(0.16, 0.34, 0.68, mat('#4c2a18', 'sofa'), 3.38, 0.44, 2.38);
    box(0.16, 0.34, 0.68, mat('#4c2a18', 'sofa'), 5.32, 0.44, 2.38);
    // Round Walnut Bistro Coffee Table + 2 Ceramic Mugs
    add(cyl(0.46, 0.46, 0.05, woodM), 4.35, 0.48, 1.62);
    add(cyl(0.05, 0.06, 0.46, trimM), 4.35, 0.23, 1.62);
    add(cyl(0.05, 0.04, 0.1, mat('#fef3c7', 'kertas')), 4.18, 0.55, 1.58);
    add(cyl(0.05, 0.04, 0.1, mat('#fef3c7', 'kertas')), 4.52, 0.55, 1.66);

    // Decorative lush indoor cafe plants
    const potM = mat('#5c3d28', 'pot');
    const leafM = mat('#15803d', 'daun');
    const leaf2M = mat('#22c55e', 'daun');
    const plant = (x: number, z: number, s = 1) => {
      add(cyl(0.18 * s, 0.14 * s, 0.36 * s, potM), x, 0.18 * s, z);
      add(cone(0.3 * s, 0.8 * s, leafM), x, 0.76 * s, z);
      add(ball(0.22 * s, leaf2M), x + 0.1 * s, 0.64 * s, z + 0.08 * s);
    };
    plant(-6.45, 2.55, 1.1);
    plant(6.45, 2.55, 1.1);
    plant(-3.1, 2.45, 0.85);
    plant(2.35, 2.45, 0.85);

    const pendant: Mesh[] = [];
    for (const [x, z] of [
      [-4.35, -0.15],
      [0.0, 0.55],
      [4.25, -0.55],
    ] as const) {
      box(0.02, 0.9, 0.02, trimM, x, 3.15, z);
      pendant.push(add(cone(0.32, 0.24, mat('#3f2a1d', 'lampu', '#f59e0b'), true), x, 2.62, z));
    }

    const dunia: Dunia =
      K.dunia?.({
        scene,
        kantor,
        K,
        pasang: (g, m, x, y, z, induk = kantor) => {
          const me = new Mesh(g, m);
          me.position.set(x, y, z);
          induk.add(me);
          return me;
        },
      }) ?? {};
    const naik = dunia.tinggi ?? 0;
    kantor.position.y = naik;
    target.y += naik;

    // ---------- IT Workstations & "Anak IT" Agents (facing -Z toward dual monitors!) ----------
    const legM = mat('#334155', 'kaki');
    const chairM = mat('#1e293b', 'kursi');
    const shadowM = new MeshBasicMaterial({ color: '#020617', transparent: true, opacity: 0.22, depthWrite: false });
    const eyeWhiteM = new MeshBasicMaterial({ color: '#f8fafc' });
    const eyePupilM = new MeshBasicMaterial({ color: '#0f172a' });
    const headsetM = new MeshLambertMaterial({ color: '#0f172a', emissive: '#082f49' });
    const headsetGlowM = new MeshBasicMaterial({ color: '#22d3ee' });
    const cupMat = new MeshLambertMaterial({ color: '#f8fafc', emissive: '#38bdf8', emissiveIntensity: 0.2 });
    const glassesM = new MeshBasicMaterial({ color: '#0f172a' });
    const sneakerM = new MeshLambertMaterial({ color: '#e2e8f0' });
    const eyeWhiteGeo = geo(new SphereGeometry(0.036, 10, 8));
    const eyePupilGeo = geo(new SphereGeometry(0.019, 8, 6));
    const earcupGeo = geo(new CylinderGeometry(0.068, 0.068, 0.04, 12));
    const earRingGeo = geo(new CylinderGeometry(0.048, 0.048, 0.045, 12));
    const headbandGeo = geo(new BoxGeometry(0.46, 0.045, 0.06));
    const micGeo = geo(new BoxGeometry(0.02, 0.02, 0.16));
    const glassesFrameGeo = geo(new BoxGeometry(0.28, 0.055, 0.025));
    const hoodBackGeo = geo(new BoxGeometry(0.32, 0.18, 0.14));
    const badgeFrontGeo = geo(new BoxGeometry(0.14, 0.1, 0.03));
    const cupGeo = geo(new CylinderGeometry(0.048, 0.038, 0.11, 10));
    const shoeGeo = geo(new BoxGeometry(0.13, 0.08, 0.2));
    disposables.push(shadowM, eyeWhiteM, eyePupilM, headsetM, headsetGlowM, cupMat, glassesM, sneakerM);

    const nightLights = !!cinematic && !touch;
    const hk = 0.24 * (K.agen.kepala - 1);

    const actors: Actor[] = desks.map((d, i) => {
      const { x, z } = d.desk;
      const isSupervisor = d.desk.key === 'spv-noc';
      const deskW = isSupervisor ? 1.88 : 1.44;

      // Cafe-Datacenter Warm Walnut Workstation Desk (wider executive desk for SPV NOC!)
      const deskTop = box(deskW, 0.08, 0.78, mat('#5c3d28', 'meja', '#000000'), x, 0.78, z);
      box(deskW - 0.12, 0.7, 0.05, legM, x, 0.38, z - 0.33);
      box(0.06, 0.74, 0.68, trimM, x - deskW / 2 + 0.07, 0.38, z);
      box(0.06, 0.74, 0.68, trimM, x + deskW / 2 - 0.07, 0.38, z);
      if (isSupervisor) {
        // Golden/Cyan SPV Command Desk Edge Trim
        const goldTrimMat = new MeshBasicMaterial({ color: '#fbbf24' });
        disposables.push(goldTrimMat);
        box(deskW + 0.04, 0.03, 0.03, goldTrimMat, x, 0.79, z + 0.39);
      }

      // Dynamic Live Network Ping CanvasTexture Screens!
      const screenCtrl = createPingMonitorController(isSupervisor);
      disposables.push(screenCtrl);
      const primaryScreenMat = new MeshBasicMaterial({ map: screenCtrl.primaryTex });
      const secondaryScreenMat = new MeshBasicMaterial({ map: screenCtrl.secondaryTex });
      disposables.push(primaryScreenMat, secondaryScreenMat);

      // Primary Live Ping Widescreen Monitor facing +Z toward seated agent
      const mainMonW = isSupervisor ? 0.86 : 0.74;
      const mainMonH = isSupervisor ? 0.48 : 0.44;
      const mainMonX = isSupervisor ? x : x - 0.14;
      box(mainMonW, mainMonH, 0.05, trimM, mainMonX, 1.14, z - 0.24);
      const screen = add(new Mesh(geo(new PlaneGeometry(mainMonW - 0.06, mainMonH - 0.06)), primaryScreenMat), mainMonX, 1.14, z - 0.21);
      box(0.08, 0.16, 0.08, trimM, mainMonX, 0.9, z - 0.24);

      // Secondary Monitor (angled right) showing CPU/Hotspot/PPPoE/Loss bars
      const secX = isSupervisor ? x + 0.64 : x + 0.44;
      const secFrame = box(0.48, 0.35, 0.04, trimM, secX, 1.1, z - 0.13);
      secFrame.rotation.set(0, -0.38, 0);
      const screen2 = add(new Mesh(geo(new PlaneGeometry(0.42, 0.29)), secondaryScreenMat), secX - 0.015, 1.1, z - 0.105);
      screen2.rotation.set(0, -0.38, 0);

      // Third Wing Monitor (angled left) exclusively for SPV NOC Executive Command Station!
      if (isSupervisor) {
        const leftFrame = box(0.48, 0.35, 0.04, trimM, x - 0.64, 1.1, z - 0.13);
        leftFrame.rotation.set(0, 0.38, 0);
        const screen3 = add(new Mesh(geo(new PlaneGeometry(0.42, 0.29)), primaryScreenMat), x - 0.625, 1.1, z - 0.105);
        screen3.rotation.set(0, 0.38, 0);
      }

      // Glowing Mechanical Keyboard & Mouse + Cafe Coffee Mug on every desk!
      const kbGlow = isSupervisor ? '#fbbf24' : '#38bdf8';
      box(0.5, 0.025, 0.17, mat('#0f172a', 'bingkai'), x - 0.08, 0.835, z + 0.08);
      box(0.46, 0.01, 0.13, mat(kbGlow, 'lampu', kbGlow), x - 0.08, 0.85, z + 0.08);
      box(0.09, 0.025, 0.13, trimM, x + 0.28, 0.835, z + 0.09);
      // Warm Cafe Ceramic Mug next to keyboard
      add(cyl(0.045, 0.036, 0.095, mat('#fef3c7', 'kertas')), x - 0.48, 0.87, z + 0.14);

      const book = box(0.32, 0.05, 0.24, mat('#f59e0b', 'buku'), x + 0.46, 0.85, z + 0.12);
      const lamp = add(ball(0.075, mat('#fde68a', 'lampu', '#f59e0b')), x - (isSupervisor ? 0.78 : 0.58), 1.08, z - 0.16);
      box(0.035, 0.26, 0.035, trimM, x - (isSupervisor ? 0.78 : 0.58), 0.95, z - 0.16);

      let light: PointLight | null = null;
      if (nightLights) {
        light = new PointLight(isSupervisor ? '#fbbf24' : '#fde68a', 0, isSupervisor ? 5.2 : 3.8, 1.6);
        light.position.set(x, 1.55, z + 0.15);
        kantor.add(light);
      }

      // Ergonomic Gaming/NOC Chair (backrest at z + 1.02 BEHIND the agent!)
      box(0.56, 0.08, 0.54, chairM, x, 0.49, z + 0.72);
      box(0.54, isSupervisor ? 0.78 : 0.68, 0.08, chairM, x, isSupervisor ? 0.92 : 0.87, z + 1.02);
      box(0.42, 0.12, 0.04, mat(isSupervisor ? '#fbbf24' : d.desk.color, 'baju'), x, isSupervisor ? 1.18 : 1.1, z + 0.98);
      box(0.07, 0.46, 0.07, legM, x, 0.25, z + 0.72);

      const sh = add(new Mesh(geo(new CircleGeometry(isSupervisor ? 1.1 : 0.9, 24)), shadowM), x, 0.006, z + 0.35);
      sh.rotation.x = -Math.PI / 2;

      // ---------- IT Engineer ("Anak IT") / SPV NOC Character — LOCAL FRONT = -Z (FACING MONITOR!) ----------
      const root = new Group();
      const seat = new Vector3(x, 0, z + 0.68);
      root.position.copy(seat);

      const hoodieM = mat(isSupervisor ? '#0f172a' : d.desk.color, 'baju');
      const joggersM = mat('#1e293b', 'celana');
      const skinM = mat(SKIN[i % SKIN.length]!, 'kulit');
      const accentRingMat = isSupervisor ? new MeshBasicMaterial({ color: '#fbbf24' }) : headsetGlowM;
      if (isSupervisor) disposables.push(accentRingMat);

      // Hoodie torso + draped hood on BACK (+Z) + tech badge on FRONT (-Z)
      const body = add(new Mesh(K.kapsul(0.23, 0.4, 'baju'), hoodieM), 0, 0.92, 0, root);
      body.scale.setScalar(K.agen.badan * (isSupervisor ? 1.06 : 1));
      const hoodBack = new Mesh(hoodBackGeo, hoodieM);
      hoodBack.position.set(0, 0.2, 0.2);
      body.add(hoodBack);
      const frontBadge = new Mesh(badgeFrontGeo, accentRingMat);
      frontBadge.position.set(0, 0.06, -0.22);
      body.add(frontBadge);

      // Head with unmistakable FRONT FACE (-Z: Eyes + Optional Tech Glasses) & IT Headset
      const head = add(ball(0.22, skinM), 0, 1.43 + hk, 0, root);
      const hair = add(ball(0.236, mat(HAIR[i % HAIR.length]!, 'rambut'), true), 0, 0.02, 0.03, head);
      hair.rotation.x = 0.28;

      for (const ex of [-0.075, 0.075]) {
        const ew = new Mesh(eyeWhiteGeo, eyeWhiteM);
        ew.position.set(ex, 0.025, -0.2);
        head.add(ew);
        const ep = new Mesh(eyePupilGeo, eyePupilM);
        ep.position.set(ex, 0.025, -0.228);
        head.add(ep);
      }

      if (i % 2 === 1 || isSupervisor) {
        const gl = new Mesh(glassesFrameGeo, glassesM);
        gl.position.set(0, 0.025, -0.22);
        head.add(gl);
      }

      // Over-ear NOC Headset + Glowing Rings + Boom Mic on -Z (front mouth side)
      const hb = new Mesh(headbandGeo, isSupervisor ? accentRingMat : headsetM);
      hb.position.set(0, 0.225, 0);
      head.add(hb);
      for (const sx of [-0.23, 0.23]) {
        const ec = new Mesh(earcupGeo, headsetM);
        ec.rotation.z = Math.PI / 2;
        ec.position.set(sx, 0.02, -0.01);
        head.add(ec);
        const er = new Mesh(earRingGeo, accentRingMat);
        er.rotation.z = Math.PI / 2;
        er.position.set(sx * 1.03, 0.02, -0.01);
        head.add(er);
      }
      const mic = new Mesh(micGeo, headsetM);
      mic.position.set(-0.16, -0.06, -0.14);
      mic.rotation.y = 0.45;
      head.add(mic);

      head.scale.setScalar(K.agen.kepala);

      const limb = (r: number, len: number, m: Material, px: number, py: number) => {
        const g = K.kapsul(r, len, peranDari(m));
        g.translate(0, -len / 2 - r / 2, 0);
        return add(new Mesh(g, m), px, py, 0, root);
      };
      const armL = limb(0.07, 0.34, hoodieM, -0.29, 1.12);
      const armR = limb(0.07, 0.34, hoodieM, 0.29, 1.12);
      const legL = limb(0.085, 0.38, joggersM, -0.11, 0.62);
      const legR = limb(0.085, 0.38, joggersM, 0.11, 0.62);

      const shoeL = new Mesh(shoeGeo, sneakerM);
      shoeL.position.set(0, -0.42, -0.05);
      legL.add(shoeL);
      const shoeR = new Mesh(shoeGeo, sneakerM);
      shoeR.position.set(0, -0.42, -0.05);
      legR.add(shoeR);

      const cup = new Mesh(cupGeo, cupMat);
      cup.position.set(0, -0.38, -0.06);
      cup.visible = false;
      armR.add(cup);

      kantor.add(root);
      return {
        key: d.desk.key,
        nama: d.agen.nama,
        isSupervisor,
        root,
        body,
        head,
        armL,
        armR,
        legL,
        legR,
        cup,
        screen,
        screen2,
        screenCtrl,
        deskTop,
        book,
        lamp,
        light,
        seat,
        label: new Vector3(),
        phase: i * 1.7,
        index: i,
      };
    });

    // ---------- Camera + Full Interactive OrbitControls (Zoom In/Out, Rotate, Pan) ----------
    const homeTarget = target.clone();
    const defaultCameraOffset = new Vector3(13.5, 12.2, 13.5);
    camera.position.copy(homeTarget).add(defaultCameraOffset);
    camera.lookAt(homeTarget);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(homeTarget);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.enableRotate = true;
    controls.minPolarAngle = 0.22;
    controls.maxPolarAngle = Math.PI / 2 - 0.06;
    controls.minZoom = 0.45;
    controls.maxZoom = 3.2;
    controls.zoomSpeed = 1.15;
    controls.rotateSpeed = 0.75;
    controls.panSpeed = 0.85;
    controls.update();

    // Smooth programmatic camera animation (cancelled immediately when admin drags/zooms manually)
    let animGoal: { target: Vector3; zoom: number; pos?: Vector3 } | null = null;
    const cancelManualOverride = () => {
      animGoal = null;
    };
    controls.addEventListener('start', cancelManualOverride);

    if (cameraApi) {
      cameraApi.current = {
        zoomIn: () => {
          animGoal = { target: controls.target.clone(), zoom: Math.min(3.2, camera.zoom * 1.28) };
        },
        zoomOut: () => {
          animGoal = { target: controls.target.clone(), zoom: Math.max(0.45, camera.zoom / 1.28) };
        },
        resetView: () => {
          animGoal = {
            target: homeTarget.clone(),
            pos: homeTarget.clone().add(defaultCameraOffset),
            zoom: 1.0,
          };
        },
        focusAgent: (key: string) => {
          const found = actors.find((a) => a.key === key);
          if (!found) return;
          animGoal = {
            target: new Vector3(found.root.position.x, 1.0 + naik, found.root.position.z),
            zoom: Math.max(camera.zoom, 1.65),
          };
        },
      };
    }

    const fit = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      const aspect = w / h;
      const portrait = !!cinematic && aspect < 0.8;
      let halfW = (cinematic ? (portrait ? 5.6 : 7.6) : 7.8) * (dunia.lebar ?? 1);
      let halfH = halfW / aspect;
      const minH = (cinematic ? (portrait ? 3.4 : 4.9) : 5.0) * (dunia.lebar ?? 1);
      if (halfH < minH) {
        halfH = minH;
        halfW = halfH * aspect;
      }
      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.updateProjectionMatrix();
      live.current.dirty = true;
      redraw?.();
    };
    let redraw: (() => void) | null = null;
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const reduce = !manual && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const proj = new Vector3();
    const place = (node: HTMLElement | null | undefined, at: Vector3) => {
      if (!node) return;
      proj.copy(at).project(camera);
      if (proj.z > 1.05 || proj.z < -1.05) {
        node.style.opacity = '0';
        return;
      }
      node.style.opacity = '1';
      const x = ((proj.x + 1) / 2) * el.clientWidth;
      const y = ((1 - proj.y) / 2) * el.clientHeight;
      node.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    };
    const boardAt = new Vector3(BOARD.x, 3.72 + naik, Z0 + 0.1);
    const labelAt = new Vector3();
    const dest = new Vector3();
    const pos = new Vector3();
    const ahead = new Vector3();

    // Corridor routing (z = 0.05 through the open doorways) so agents never clip through partition walls
    const CORRIDOR = 0.05;
    const pathAt = (from: Vector3, to: Vector3, k: number, out: Vector3) => {
      const p1z = CORRIDOR;
      const l1 = Math.abs(p1z - from.z);
      const l2 = Math.abs(to.x - from.x);
      const l3 = Math.abs(to.z - p1z);
      const L = l1 + l2 + l3 || 1;
      let d = k * L;
      if (d <= l1) return out.set(from.x, 0, from.z + Math.sign(p1z - from.z) * d);
      d -= l1;
      if (d <= l2) return out.set(from.x + Math.sign(to.x - from.x) * d, 0, p1z);
      d -= l2;
      return out.set(to.x, 0, p1z + Math.sign(to.z - p1z) * Math.min(d, l3));
    };

    const rackSpots = [
      new Vector3(-5.8, 0, -2.35),
      new Vector3(-2.55, 0, -2.35),
      new Vector3(2.75, 0, -2.35),
      new Vector3(5.85, 0, -2.35),
    ];

    // ---------- Live 3D Fiber Optic Cables (Synced from Manual GUI Topology Map!) ----------
    const fiberGroup = new Group();
    kantor.add(fiberGroup);
    let lastFiberSig = '';
    const fiberMeshes: { mesh: Mesh; mat: MeshBasicMaterial; status: LiveTopologyLink['status'] }[] = [];
    const clearFiberCables = () => {
      for (const item of fiberMeshes) {
        item.mesh.geometry.dispose();
        item.mat.dispose();
        item.mesh.removeFromParent();
      }
      fiberMeshes.length = 0;
    };
    disposables.push({ dispose: () => { clearFiberCables(); fiberGroup.removeFromParent(); } });

    const sync3dFiberCables = (links: readonly LiveTopologyLink[]) => {
      const sig = links.map((l) => `${l.id}:${l.fromRouterId}:${l.toRouterId}:${l.status}:${l.color ?? ''}`).join('|');
      if (sig === lastFiberSig) return;
      lastFiberSig = sig;
      clearFiberCables();

      const pairIdx = new Map<string, number>();
      for (const link of links) {
        const aFrom = actors.find((a) => a.key === link.fromRouterId);
        const aTo = actors.find((a) => a.key === link.toRouterId);
        if (!aFrom || !aTo) continue;

        const pk = [link.fromRouterId, link.toRouterId].sort().join('::');
        const idx = pairIdx.get(pk) ?? 0;
        pairIdx.set(pk, idx + 1);

        const p0 = new Vector3(aFrom.seat.x, 0.08, aFrom.seat.z - 0.52);
        const p2 = new Vector3(aTo.seat.x, 0.08, aTo.seat.z - 0.52);
        const mid = new Vector3().addVectors(p0, p2).multiplyScalar(0.5);
        // Gentle overhead/floor glowing arc that stays visually clean without blocking monitors
        mid.y = 0.24 + idx * 0.16;
        const curve = new QuadraticBezierCurve3(p0, mid, p2);
        const tubeGeo = new TubeGeometry(curve, 24, link.status === 'down' ? 0.032 : 0.024, 6, false);
        const hex =
          link.status === 'down'
            ? '#ef4444'
            : link.status === 'degraded'
              ? '#f59e0b'
              : link.color || (link.fiberType === 'vlan' ? '#fbbf24' : link.fiberType === 'olt' ? '#22c55e' : '#38bdf8');
        const tubeMat = new MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.9 });
        const mesh = new Mesh(tubeGeo, tubeMat);
        fiberGroup.add(mesh);
        fiberMeshes.push({ mesh, mat: tubeMat, status: link.status });
      }
    };

    let lastNight: boolean | null = null;
    let lastScreenTick = -1;
    const applyState = (t: number) => {
      const {
        desks: list,
        pingFeeds: feeds,
        externalPings: extPings,
        topologyLinks: topoLinks,
        activeAlerts: alertTotal,
        boardCount: count,
      } = live.current;
      sync3dFiberCables(topoLinks);
      for (const fm of fiberMeshes) {
        if (fm.status === 'down') {
          fm.mat.opacity = 0.25 + 0.75 * Math.abs(Math.sin(t * 7));
        } else {
          fm.mat.opacity = 0.72 + 0.22 * Math.sin(t * 2.5);
        }
      }
      const isNight = live.current.night || !!K.selaluMalam;
      if (isNight !== lastNight) {
        lastNight = isNight;
        const w = K.warna;
        hemi.intensity = isNight ? 0.55 * (K.selaluMalam ? 2.1 : 1) : C.kuat;
        hemi.color.set(isNight ? (K.selaluMalam ? C.langit : '#7d8cff') : C.langit);
        sun.intensity = isNight ? 0.35 * (K.selaluMalam ? 2.6 : 1) : C.mKuat;
        sun.color.set(isNight ? '#fff7ed' : C.matahari);
        amb.intensity = isNight ? 0.42 : 0.45;
        glassM.color.set(w(isNight ? '#0e7490' : '#bfe3ff', 'kaca'));
        glassM.emissive.set(w(isNight ? '#082f49' : '#7fb8e6', 'kaca'));
        for (const f of floors) f.m.color.set(w(isNight ? f.r.floorNight : f.r.floor, 'lantai'));
        lineM.color.set(w(isNight ? '#2e241d' : '#cdb79c', 'garis'));
        for (const p of pendant) (p.material as MeshLambertMaterial).emissive.set(isNight ? '#f59e0b' : '#000000');
        if (scene.fog && K.kabut) (scene.fog as Fog).color.set(isNight ? K.kabut[1] : K.kabut[0]);
        dunia.malam?.(isNight);
      }

      notes.forEach((n, i) => (n.visible = i < count));

      // Update live Network Ping CanvasTextures on all monitors & Giant Video Wall every ~450ms
      const screenTick = Math.floor(t * 2.2);
      if (screenTick !== lastScreenTick) {
        lastScreenTick = screenTick;
        videoWallCtrl.update(screenTick, feeds, extPings, alertTotal);
        for (const a of actors) {
          const feed = feeds.find((f) => f.key === a.key);
          a.screenCtrl.update(screenTick + a.index * 3, feed, feeds, extPings);
        }
      }

      for (const a of actors) {
        const d = list.find((x) => x.desk.key === a.key);
        if (d) a.nama = d.agen.nama;
        const act = d?.doing.activity ?? 'kerja';
        const hasAlert = Boolean(d && (d.urgent.length > 0 || d.waiting.length > 0));
        a.root.visible = act !== 'pulang';

        a.book.visible = act === 'belajar';
        a.lamp.visible = true;
        if (a.light) a.light.intensity = isNight ? (a.isSupervisor ? 1.8 : 1.2) : 0;

        const dm = a.deskTop.material as MeshLambertMaterial;
        if (d?.urgent.length) {
          dm.emissive.set('#ef4444');
          dm.emissiveIntensity = reduce ? 0.45 : 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 6));
        } else {
          dm.emissive.set('#140b06');
          dm.emissiveIntensity = 0.32;
        }

        // Autonomous cafe-datacenter life behavior (SPV NOC stays at executive desk when supervising!)
        let mode: LifeMode = 'kerja';
        let k = 0;
        let walking = false;
        let going = false;
        let peerActor: Actor | null = null;

        if (!a.isSupervisor && !hasAlert && !reduce && !manual) {
          const life = agentLifeAt(a.index, t);
          mode = life.mode;
          k = life.k;
          walking = life.walking;
          going = life.going;
          if (mode === 'ngobrol' && actors.length > 1) {
            peerActor = actors[(a.index + life.peerOffset) % actors.length] ?? null;
          }
        }

        const slot = (a.index % 3) - 1;
        if (mode === 'minum') {
          // Visit Artisan Cafe Espresso Bar at front-left (-1.55, 1.55)
          dest.set(-1.55 + slot * 0.42, 0, 1.55);
        } else if (mode === 'istirahat') {
          // Relax on Front-Right Cafe Lounge Sofa (4.35, 2.25)
          dest.set(4.35 + slot * 0.52, 0, 2.28);
        } else if (mode === 'ngobrol' && peerActor) {
          const sideX = peerActor.seat.x > 0 ? -0.95 : 0.95;
          dest.set(peerActor.seat.x + sideX, 0, peerActor.seat.z + 0.1);
        } else if (mode === 'rak') {
          dest.copy(rackSpots[a.index % rackSpots.length]!);
        } else {
          dest.copy(a.seat);
        }

        pathAt(a.seat, dest, k, pos);
        a.root.position.copy(pos);

        const atDesk = k === 0;
        const onSofa = mode === 'istirahat' && k === 1;
        const sitting = atDesk || onSofa;

        // Orientation: agent's LOCAL FRONT is -Z!
        if (!atDesk && walking) {
          pathAt(a.seat, dest, Math.min(1, Math.max(0, k + (going ? 0.025 : -0.025))), ahead);
          const dx = ahead.x - pos.x;
          const dz = ahead.z - pos.z;
          if (dx * dx + dz * dz > 1e-8) {
            a.root.rotation.set(0, Math.atan2(-dx, -dz), 0);
          }
        } else if (mode === 'ngobrol' && k === 1 && peerActor) {
          const dx = peerActor.seat.x - pos.x;
          const dz = peerActor.seat.z - pos.z;
          a.root.rotation.set(0, Math.atan2(-dx, -dz), 0);
        } else if (mode === 'minum' && k === 1) {
          // Face +Z directly toward the Artisan Espresso Bar counter at z=2.38!
          a.root.rotation.set(0, Math.PI, 0);
        } else if (onSofa) {
          // Face -Z (into the room & round bistro table, backrest behind at +Z!)
          a.root.rotation.set(0, 0, 0);
        } else {
          // Seated at desk or inspecting server rack -> face -Z directly toward Ping monitor/rack!
          a.root.rotation.set(0, 0, 0);
        }

        a.root.position.y = onSofa ? -0.06 : 0;
        a.cup.visible = mode === 'minum' && k >= 0.85;
        a.label.set(pos.x, (sitting ? 1.82 : 2.02) + hk * 2, pos.z);

        // Update live HTML tag status text smoothly when roaming
        const tagEl = anchors.current?.get(a.key);
        const statusSpan = tagEl?.querySelector<HTMLElement>('.ko-name-act');
        if (statusSpan && d) {
          if (mode === 'minum' && k > 0.15) {
            statusSpan.textContent = k < 0.9 ? '☕ menuju kopi/air…' : '☕ ambil minum…';
          } else if (mode === 'istirahat' && k > 0.15) {
            statusSpan.textContent = k < 0.9 ? '🚶 ke sofa lounge…' : '🛋 istirahat sejenak…';
          } else if (mode === 'ngobrol' && k > 0.15 && peerActor) {
            const shortPeer = peerActor.nama.split(' ')[0] ?? 'rekan';
            statusSpan.textContent = k < 0.9 ? `🚶 menghampiri ${shortPeer}…` : `💬 diskusi dg ${shortPeer}…`;
          } else if (mode === 'rak' && k > 0.15) {
            statusSpan.textContent = k < 0.9 ? '🚶 menuju rak server…' : '🖥 cek rak 42U…';
          } else {
            statusSpan.textContent = d.doing.label;
          }
        }

        if (reduce) continue;

        const walkWave = Math.sin(t * 9.5 + a.phase);
        if (!sitting) {
          const bob = walking ? 0.032 * Math.abs(walkWave) : 0;
          a.body.position.y = 0.98 + bob;
          a.head.position.y = 1.49 + hk + bob;
          a.armL.position.y = a.armR.position.y = 1.18 + bob;
          a.legL.position.y = a.legR.position.y = 0.7;
          a.legL.rotation.set(walking ? 0.58 * walkWave : 0, 0, 0);
          a.legR.rotation.set(walking ? -0.58 * walkWave : 0, 0, 0);

          if (walking) {
            a.armL.rotation.set(0.5 * walkWave, 0, 0.08);
            a.armR.rotation.set(-0.5 * walkWave, 0, -0.08);
            a.head.rotation.set(0, 0, 0);
          } else if (mode === 'minum') {
            // Holding coffee cup in FRONT (-Z) & sipping (positive rotX swings hanging limb forward toward -Z!)
            const sip = 0.5 + 0.5 * Math.sin(t * 2.2 + a.phase);
            a.armL.rotation.set(0.25, 0, 0.1);
            a.armR.rotation.set(1.1 + 0.55 * sip, 0, -0.18);
            a.head.rotation.set(0.08 * sip, 0, 0);
          } else if (mode === 'ngobrol') {
            // Animated gesturing in FRONT (-Z) while talking with colleague
            a.armL.rotation.set(0.65 + 0.3 * Math.sin(t * 6 + a.phase), 0, 0.22);
            a.armR.rotation.set(0.75 + 0.35 * Math.cos(t * 5.2 + a.phase), 0, -0.22);
            a.head.rotation.set(0.06 * Math.sin(t * 4 + a.phase), 0.14 * Math.sin(t * 2.1 + a.phase), 0);
          } else if (mode === 'rak') {
            // Inspecting blinking 42U server rack blades in FRONT (-Z)
            a.armL.rotation.set(0.82, 0, 0.12);
            a.armR.rotation.set(0.38, 0, -0.1);
            a.head.rotation.set(0.14 + 0.1 * Math.sin(t * 1.6 + a.phase), 0.18 * Math.sin(t * 1.1 + a.phase), 0);
          } else {
            a.armL.rotation.set(0, 0, 0.08);
            a.armR.rotation.set(0, 0, -0.08);
            a.head.rotation.set(0, 0, 0);
          }
        } else if (onSofa) {
          // Relaxed sitting & gentle stretching on the break lounge sofa (legs & arms forward toward -Z!)
          a.legL.position.y = a.legR.position.y = 0.62;
          a.legL.rotation.set(1.35, 0, 0.08);
          a.legR.rotation.set(1.35, 0, -0.08);
          a.body.position.y = 0.91 + 0.012 * Math.sin(t * 1.8 + a.phase);
          a.head.position.y = 1.41 + hk + 0.012 * Math.sin(t * 1.8 + a.phase);
          a.armL.position.y = a.armR.position.y = 1.11;
          const stretch = Math.max(0, Math.sin(t * 0.7 + a.phase));
          a.armL.rotation.set(0.35 + 0.5 * stretch, 0, 0.35);
          a.armR.rotation.set(0.35 + 0.5 * stretch, 0, -0.35);
          a.head.rotation.set(0.08 * stretch, 0.25 * Math.sin(t * 0.8 + a.phase), 0);
        } else {
          // Seated at IT desk facing -Z (DUAL MONITORS!) — positive rotX sends legs under desk & hands onto RGB keyboard!
          a.legL.position.y = a.legR.position.y = 0.62;
          a.legL.rotation.set(1.45, 0, 0);
          a.legR.rotation.set(1.45, 0, 0);
          const typeSpeed = hasAlert ? 22 : 14;
          a.body.position.y = 0.92 + 0.01 * Math.abs(Math.sin(t * 8 + a.phase));
          a.head.position.y = 1.43 + hk;
          a.armL.position.y = a.armR.position.y = 1.12;
          a.armL.rotation.set(1.18 + 0.12 * Math.sin(t * typeSpeed + a.phase), 0, 0.12);
          a.armR.rotation.set(1.18 + 0.12 * Math.sin(t * typeSpeed + a.phase + 2.1), 0, -0.12);
          // Slight downward gaze (-rotX on -Z gaze vector) scanning between primary & secondary monitors
          a.head.rotation.set(-0.08 + 0.04 * Math.sin(t * 2.4 + a.phase), -0.14 + 0.26 * Math.sin(t * 0.9 + a.phase), 0);
        }
      }
    };

    const updateCamera = (t: number) => {
      if (live.current.autoTour && !reduce && !manual) {
        const angle = Math.PI / 4 + 0.32 * Math.sin(t * 0.18);
        const radius = 18.5;
        camera.position.lerp(
          new Vector3(homeTarget.x + radius * Math.sin(angle), homeTarget.y + 12.2, homeTarget.z + radius * Math.cos(angle)),
          0.03,
        );
        controls.target.lerp(homeTarget, 0.04);
      } else if (animGoal) {
        controls.target.lerp(animGoal.target, 0.12);
        if (animGoal.pos) {
          camera.position.lerp(animGoal.pos, 0.12);
        }
        camera.zoom += (animGoal.zoom - camera.zoom) * 0.14;
        camera.updateProjectionMatrix();
        const doneZoom = Math.abs(camera.zoom - animGoal.zoom) < 0.01;
        const doneTarget = controls.target.distanceTo(animGoal.target) < 0.03;
        const donePos = !animGoal.pos || camera.position.distanceTo(animGoal.pos) < 0.05;
        if (doneZoom && doneTarget && donePos) {
          animGoal = null;
        }
      }
      controls.update();
    };

    const draw = (t: number) => {
      updateCamera(t);
      applyState(t);
      renderer.render(scene, camera);
      for (const a of actors) place(anchors.current?.get(a.key), labelAt.set(a.label.x, a.label.y + naik, a.label.z));
      place(boardAnchor.current, boardAt);
      live.current.dirty = false;
    };

    let lastT = 0;
    if (drive) drive.current = (t: number) => draw((lastT = t));
    if (manual) redraw = () => draw(lastT);

    let raf = 0;
    let running = true;
    let visible = true;
    let last = 0;
    const minGap = touch ? 1000 / 30 : 0;
    const start = performance.now();
    const frame = (now: number) => {
      raf = 0;
      if (!running || !visible || document.hidden) return;
      if (now - last >= minGap) {
        last = now;
        draw((now - start) / 1000);
      }
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!manual && !raf && running) raf = requestAnimationFrame(frame);
    };
    const poll = reduce ? window.setInterval(() => live.current.dirty && kick(), 250) : 0;
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      if (visible) kick();
    });
    io.observe(el);
    const onVis = () => !document.hidden && kick();
    document.addEventListener('visibilitychange', onVis);
    renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      onFail?.();
    });
    if (manual) draw(0);
    kick();
    onReady?.();

    return () => {
      running = false;
      if (drive) drive.current = null;
      if (cameraApi) cameraApi.current = null;
      if (raf) cancelAnimationFrame(raf);
      window.clearInterval(poll);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      controls.removeEventListener('start', cancelManualOverride);
      controls.dispose();
      for (const d of disposables) d.dispose();
      K.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desks.map((d) => d.desk.key).join(','), cinematic, manual, gaya]);

  return <div ref={host} className="ko-canvas" />;
}
