import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgentRoom, RouterDevice } from './types.js';

export const DEFAULT_ROUTERS: readonly RouterDevice[] = [
  {
    id: 'crs-backbone-01',
    name: 'CRS-Backbone-01',
    deviceModel: 'CRS Backbone',
    host: '192.168.88.11',
    port: 8728,
    useTls: false,
    routerOsVersion: 'v7',
    role: 'core',
    agentName: 'Bima (CRS BB-01)',
    agentColor: '#e4572e',
    room: 'core',
    deskX: -5.75,
    deskZ: -1.85,
    readUsername: 'noc_readonly',
    readSecretEnv: 'MT_READ_SECRET',
    execUsername: 'ai_executor',
    execSecretEnv: 'MT_EXEC_SECRET',
    simulated: true,
  },
  {
    id: 'crs-backbone-02',
    name: 'CRS-Backbone-02',
    deviceModel: 'CRS Backbone',
    host: '192.168.88.12',
    port: 8728,
    useTls: false,
    routerOsVersion: 'v7',
    role: 'core',
    agentName: 'Sinta (CRS BB-02)',
    agentColor: '#f28482',
    room: 'core',
    deskX: -3.15,
    deskZ: -1.85,
    readUsername: 'noc_readonly',
    readSecretEnv: 'MT_READ_SECRET',
    execUsername: 'ai_executor',
    execSecretEnv: 'MT_EXEC_SECRET',
    simulated: true,
  },
  {
    id: 'core-mongkonai',
    name: 'CORE MONGKONAI',
    deviceModel: 'Core Backbone',
    host: '192.168.88.10',
    port: 8728,
    useTls: false,
    routerOsVersion: 'v7',
    role: 'core',
    agentName: 'CORE MONGKONAI',
    agentColor: '#00b4d8',
    room: 'core',
    deskX: -4.45,
    deskZ: -0.15,
    readUsername: 'noc_readonly',
    readSecretEnv: 'MT_READ_SECRET',
    execUsername: 'ai_executor',
    execSecretEnv: 'MT_EXEC_SECRET',
    simulated: true,
  },
  {
    id: 'crs-backbone-03',
    name: 'CRS-Backbone-03',
    deviceModel: 'CRS Backbone',
    host: '192.168.88.13',
    port: 8728,
    useTls: false,
    routerOsVersion: 'v7',
    role: 'core',
    agentName: 'Bayu (CRS BB-03)',
    agentColor: '#2a9d8f',
    room: 'core',
    deskX: -5.75,
    deskZ: 1.45,
    readUsername: 'noc_readonly',
    readSecretEnv: 'MT_READ_SECRET',
    execUsername: 'ai_executor',
    execSecretEnv: 'MT_EXEC_SECRET',
    simulated: true,
  },
  {
    id: 'crs-backbone-04',
    name: 'CRS-Backbone-04',
    deviceModel: 'CRS Backbone',
    host: '192.168.88.14',
    port: 8728,
    useTls: false,
    routerOsVersion: 'v7',
    role: 'core',
    agentName: 'Raka (CRS BB-04)',
    agentColor: '#8e6bd8',
    room: 'core',
    deskX: -3.15,
    deskZ: 1.45,
    readUsername: 'noc_readonly',
    readSecretEnv: 'MT_READ_SECRET',
    execUsername: 'ai_executor',
    execSecretEnv: 'MT_EXEC_SECRET',
    simulated: true,
  },
  {
    id: 'ccr-momonet-pusat',
    name: 'CCR-Pusat-MomoNet',
    deviceModel: 'CCR ROS v7 (Pusat Pelanggan)',
    host: '192.168.88.1',
    port: 8728,
    useTls: false,
    routerOsVersion: 'v7',
    role: 'bras',
    agentName: 'Rangga (CCR Momo Net)',
    agentColor: '#f2b134',
    room: 'security',
    deskX: 0.1,
    deskZ: -0.3,
    readUsername: 'noc_readonly',
    readSecretEnv: 'MT_READ_SECRET',
    execUsername: 'ai_executor',
    execSecretEnv: 'MT_EXEC_SECRET',
    simulated: true,
  },
  {
    id: 'rb750-qairen',
    name: 'RB750Gr3-QairenNet',
    deviceModel: 'RB750Gr3 ROS v6',
    host: '192.168.88.21',
    port: 8728,
    useTls: false,
    routerOsVersion: 'v6',
    role: 'branch',
    agentName: 'Nadia (Qairen Net)',
    agentColor: '#3a86ff',
    room: 'distribusi',
    deskX: 3.4,
    deskZ: -1.5,
    readUsername: 'noc_readonly',
    readSecretEnv: 'MT_READ_SECRET',
    execUsername: 'ai_executor',
    execSecretEnv: 'MT_EXEC_SECRET',
    simulated: true,
  },
  {
    id: 'rb750-dn-bangomolunow',
    name: 'RB750Gr3-DN-Bangomolunow',
    deviceModel: 'RB750Gr3 ROS v6',
    host: '192.168.88.22',
    port: 8728,
    useTls: false,
    routerOsVersion: 'v6',
    role: 'branch',
    agentName: 'Damar (DN Bangomolunow)',
    agentColor: '#ff5d8f',
    room: 'distribusi',
    deskX: 5.6,
    deskZ: -1.5,
    readUsername: 'noc_readonly',
    readSecretEnv: 'MT_READ_SECRET',
    execUsername: 'ai_executor',
    execSecretEnv: 'MT_EXEC_SECRET',
    simulated: true,
  },
  {
    id: 'rb750-dn-lolan',
    name: 'RB750Gr3-DN-Lolan',
    deviceModel: 'RB750Gr3 ROS v6',
    host: '192.168.88.23',
    port: 8728,
    useTls: false,
    routerOsVersion: 'v6',
    role: 'branch',
    agentName: 'Tio (DN Lolan)',
    agentColor: '#06d6a0',
    room: 'distribusi',
    deskX: 4.5,
    deskZ: 1.0,
    readUsername: 'noc_readonly',
    readSecretEnv: 'MT_READ_SECRET',
    execUsername: 'ai_executor',
    execSecretEnv: 'MT_EXEC_SECRET',
    simulated: true,
  },
];

const AGENT_PALETTE = ['#e4572e', '#2a9d8f', '#3a86ff', '#f2b134', '#ff5d8f', '#8e6bd8', '#06d6a0', '#f28482'];

const ROOM_SLOTS: Record<AgentRoom, readonly (readonly [number, number])[]> = {
  core: [
    [-5.6, -1.6],
    [-3.2, -1.6],
    [-5.6, 1.0],
    [-3.2, 1.0],
    [-4.4, -0.3],
    [-5.6, 2.2],
  ],
  security: [
    [0.1, -0.3],
    [-0.6, 1.3],
    [0.9, 1.3],
    [0.1, -1.7],
  ],
  distribusi: [
    [3.4, -1.5],
    [5.6, -1.5],
    [4.5, 1.0],
    [3.2, 1.4],
    [5.8, 1.2],
    [4.5, -0.3],
  ],
};

export function allocateDeskSlot(
  existing: readonly RouterDevice[],
  room: AgentRoom,
): { readonly deskX: number; readonly deskZ: number; readonly color: string } {
  const slots = ROOM_SLOTS[room];
  const color = AGENT_PALETTE[existing.length % AGENT_PALETTE.length]!;
  for (const [sx, sz] of slots) {
    const occupied = existing.some((r) => Math.hypot(r.deskX - sx, r.deskZ - sz) < 0.7);
    if (!occupied) {
      return { deskX: sx, deskZ: sz, color };
    }
  }
  const fallback = slots[existing.length % slots.length]!;
  return { deskX: fallback[0], deskZ: fallback[1], color };
}

let inventoryPersistChain: Promise<void> = Promise.resolve();

export async function loadRouterInventory(configPath: string): Promise<readonly RouterDevice[]> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as RouterDevice[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch {
    await saveRouterInventory(configPath, DEFAULT_ROUTERS);
  }
  return DEFAULT_ROUTERS;
}

export function saveRouterInventory(configPath: string, routers: readonly RouterDevice[]): Promise<void> {
  const payload = JSON.stringify(routers, null, 2);
  inventoryPersistChain = inventoryPersistChain
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const tmpPath = `${configPath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
      await fs.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmpPath, configPath);
    });
  return inventoryPersistChain;
}
