import laporanAgen from './laporan.json';
import type { GayaId } from './gaya/daftar';

export const KANTOR = {
  nama: 'Kantor AI NOC · Momo Net',
  subjudul: '9 MikroTik Monitoring (CORE MONGKONAI, 4 CRS, CCR Pusat, 3 RB750Gr3)',
};

export const GAYA: GayaId = 'datacenter';
export const TAMPIL_PEMILIH_GAYA = true;

export const RUANGAN = [
  { key: 'core', label: 'Core & Backbone (5)', x0: -7, x1: -1.8, warna: '#e9d9c4', karpet: '#e4572e' },
  { key: 'security', label: 'CCR Pusat · Momo Net', x0: -1.8, x1: 2, warna: '#efe3cf', karpet: '#f2b134' },
  { key: 'distribusi', label: 'Cabang RB750Gr3 (v6)', x0: 2, x1: 7, warna: '#e3d6c6', karpet: '#3a86ff' },
] as const;
export type RoomKey = (typeof RUANGAN)[number]['key'];

export interface Agen {
  key: string;
  nama: string;
  tugas: string;
  ruang: RoomKey;
  warna: string;
  x: number;
  z: number;
}

export const AGEN: Agen[] = [
  { key: 'crs-backbone-01', nama: 'Bima (CRS BB-01)', tugas: 'CRS-Backbone-01 (192.168.88.11)', ruang: 'core', warna: '#e4572e', x: -5.75, z: -1.85 },
  { key: 'crs-backbone-02', nama: 'Sinta (CRS BB-02)', tugas: 'CRS-Backbone-02 (192.168.88.12)', ruang: 'core', warna: '#f28482', x: -3.15, z: -1.85 },
  { key: 'core-mongkonai', nama: 'CORE MONGKONAI', tugas: 'CORE MONGKONAI (192.168.88.10)', ruang: 'core', warna: '#00b4d8', x: -4.45, z: -0.15 },
  { key: 'crs-backbone-03', nama: 'Bayu (CRS BB-03)', tugas: 'CRS-Backbone-03 (192.168.88.13)', ruang: 'core', warna: '#2a9d8f', x: -5.75, z: 1.45 },
  { key: 'crs-backbone-04', nama: 'Raka (CRS BB-04)', tugas: 'CRS-Backbone-04 (192.168.88.14)', ruang: 'core', warna: '#8e6bd8', x: -3.15, z: 1.45 },
  { key: 'ccr-momonet-pusat', nama: 'Rangga (CCR Momo Net)', tugas: 'CCR-Pusat-MomoNet (192.168.88.1)', ruang: 'security', warna: '#f2b134', x: 0.1, z: -0.3 },
  { key: 'rb750-qairen', nama: 'Nadia (Qairen Net)', tugas: 'RB750Gr3-QairenNet (192.168.88.21)', ruang: 'distribusi', warna: '#3a86ff', x: 3.4, z: -1.5 },
  { key: 'rb750-dn-bangomolunow', nama: 'Damar (DN Bangomolunow)', tugas: 'RB750Gr3-DN-Bangomolunow (192.168.88.22)', ruang: 'distribusi', warna: '#ff5d8f', x: 5.6, z: -1.5 },
  { key: 'rb750-dn-lolan', nama: 'Tio (DN Lolan)', tugas: 'RB750Gr3-DN-Lolan (192.168.88.23)', ruang: 'distribusi', warna: '#06d6a0', x: 4.5, z: 1.0 },
];

export type Aktivitas = 'kerja' | 'laporan' | 'belajar';

export const JADWAL: { agen: string[] | '*'; mulai: string; menit: number; hari: number[]; aktivitas: Aktivitas; label: string }[] = [
  { agen: '*', mulai: '00:00', menit: 480, hari: [1, 2, 3, 4, 5, 6, 7], aktivitas: 'kerja', label: 'patroli log malam…' },
  { agen: '*', mulai: '08:00', menit: 480, hari: [1, 2, 3, 4, 5, 6, 7], aktivitas: 'kerja', label: 'memantau trafik MikroTik…' },
  { agen: '*', mulai: '16:00', menit: 60, hari: [1, 2, 3, 4, 5, 6, 7], aktivitas: 'laporan', label: 'rekap harian NOC…' },
  { agen: '*', mulai: '17:00', menit: 420, hari: [1, 2, 3, 4, 5, 6, 7], aktivitas: 'kerja', label: 'jaga jam sibuk (peak)…' },
];

export const JAM_KANTOR = { buka: '00:00', tutup: '23:59' };

export interface Laporan {
  ringkasan?: string;
  menunggu?: string[];
  mendesak?: string[];
  angka?: { label: string; nilai: string }[];
}

export const LAPORAN: Record<string, Laporan> = laporanAgen;

export const BABAK = [
  { dari: '07:28', sampai: '08:44', detik: 12, judul: 'Pagi · cek Backbone CRS & CCR' },
  { dari: '15:55', sampai: '16:35', detik: 9, judul: 'Sore · rekap log harian cabang' },
  { dari: '19:50', sampai: '21:00', detik: 9, judul: 'Malam · jaga trafik puncak Momo Net' },
];
