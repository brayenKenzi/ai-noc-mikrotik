import { useState } from 'react';
import type {
  LiveCustomerLookupResult,
  LiveRscBackupSummary,
} from './nocLive';

export function CustomerLookupPanel({
  onSearch,
  onOpenRouter,
}: {
  onSearch: (query: string) => Promise<LiveCustomerLookupResult>;
  onOpenRouter: (routerId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LiveCustomerLookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = query.trim();
    if (clean.length < 2 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onSearch(clean);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mencari pelanggan');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="noc-spv-reports">
      <p style={{ margin: '0 0 8px', fontSize: '0.8rem', color: '#475569' }}>
        🔍 Cari pelanggan <b>PPPoE</b> maupun <b>Hotspot</b> secara live di seluruh router sekaligus (bisa juga lewat Telegram
        dengan ketik <code>/cek &lt;nama/ip/mac&gt;</code>).
      </p>

      <form className="noc-ai-input-row" onSubmit={(e) => void handleSubmit(e)} style={{ marginBottom: '10px' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ketik username PPPoE/Hotspot, IP address, atau MAC / Caller-ID…"
          disabled={busy}
        />
        <button type="submit" className="noc-btn-approve" disabled={busy || query.trim().length < 2}>
          {busy ? 'Memindai…' : '🔍 Cek Live'}
        </button>
      </form>

      {error && <p className="noc-feedback is-err">{error}</p>}

      {result && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: '#64748b', marginBottom: '6px' }}>
            <span>
              Hasil pencarian <b>&ldquo;{result.query}&rdquo;</b> ({result.searchedRouters} router live diperiksa)
            </span>
            <span>{result.matches.length} sesi online</span>
          </div>

          {result.matches.length === 0 ? (
            <div className="noc-card" style={{ background: '#fff7ed', borderColor: '#fed7aa' }}>
              <strong style={{ color: '#9a3412' }}>⚠ Pelanggan Tidak Ditemukan Online Saat Ini</strong>
              <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: '#7c2d12' }}>
                Kemungkinan perangkat pelanggan mati/putus FO, salah ketik nama/IP/MAC, atau gagal autentikasi. Cek riwayat
                log terkait di bawah bila tersedia.
              </p>
            </div>
          ) : (
            result.matches.map((m, idx) => (
              <div key={`${m.routerId}-${m.username}-${idx}`} className="noc-spv-report-item">
                <div className="noc-card-head">
                  <strong>
                    <span
                      className="noc-status-pill is-executed"
                      style={{ marginRight: '6px', background: m.type === 'pppoe' ? '#dbeafe' : '#dcfce7', color: m.type === 'pppoe' ? '#1e40af' : '#166534' }}
                    >
                      {m.type.toUpperCase()} ONLINE
                    </span>
                    {m.username}
                  </strong>
                  <button type="button" className="noc-link-btn" onClick={() => onOpenRouter(m.routerId)}>
                    📡 {m.routerName} →
                  </button>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#334155' }}>
                  <b>IP:</b> <code>{m.address}</code> · <b>MAC/Caller-ID:</b> <code>{m.macOrCallerId}</code> · <b>Uptime:</b>{' '}
                  {m.uptime}
                  {m.viaRadius ? ' · 🔐 RADIUS' : ''}
                </p>
                {(m.txMbps !== null || m.rxMbps !== null || m.totalTxMb !== null || m.totalRxMb !== null) && (
                  <p style={{ margin: '3px 0 0', fontSize: '0.79rem', color: '#0f766e' }}>
                    {m.txMbps !== null || m.rxMbps !== null ? (
                      <>
                        <b>Trafik Live:</b> ⬇ DL {m.txMbps ?? 0} Mbps / ⬆ UL {m.rxMbps ?? 0} Mbps{' '}
                      </>
                    ) : null}
                    {m.totalTxMb !== null || m.totalRxMb !== null ? (
                      <>
                        · <b>Pemakaian Sesi:</b> DL {m.totalTxMb ?? 0} MB / UL {m.totalRxMb ?? 0} MB
                      </>
                    ) : null}
                  </p>
                )}
              </div>
            ))
          )}

          {result.relatedLogs.length > 0 && (
            <div className="noc-logs" style={{ marginTop: '10px' }}>
              <h4 style={{ margin: '0 0 6px' }}>📜 Riwayat Log Terkait ({result.relatedLogs.length})</h4>
              <ul>
                {result.relatedLogs.map((lg) => (
                  <li key={lg.id} data-sev={lg.severity}>
                    <code>[{lg.routerId}]</code> {lg.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function RscBackupVaultPanel({
  rscBackups,
  onRunBackup,
  onFetchPreview,
}: {
  rscBackups?: LiveRscBackupSummary;
  onRunBackup: () => Promise<LiveRscBackupSummary>;
  onFetchPreview: (fileName: string) => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ fileName: string; content: string } | null>(null);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const handleBackupNow = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await onRunBackup();
      const okCount = res.entries.filter((e) => e.status !== 'error').length;
      setFeedback({
        ok: true,
        text: `💾 Backup .rsc selesai (${okCount}/${res.entries.length} router) di folder terpisah mikrotik-rsc/ · ${res.lastGitSyncStatus}`,
      });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Gagal menjalankan backup .rsc' });
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePreview = async (fileName: string) => {
    if (previewFile?.fileName === fileName) {
      setPreviewFile(null);
      return;
    }
    setLoadingFile(fileName);
    try {
      const content = await onFetchPreview(fileName);
      setPreviewFile({ fileName, content });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Gagal membuka file .rsc' });
    } finally {
      setLoadingFile(null);
    }
  };

  const entries = rscBackups?.entries ?? [];

  return (
    <div className="noc-spv-reports">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
        <div style={{ fontSize: '0.8rem', color: '#475569' }}>
          <div>
            📁 Folder Terpisah: <code>mikrotik-rsc/latest/</code> &amp; <code>mikrotik-rsc/history/YYYY-MM-DD/</code>
          </div>
          <small style={{ color: '#0f766e' }}>
            🔒 Git Private Sync: <b>{rscBackups?.lastGitSyncStatus ?? 'Otomatis tiap 02:00 WITA'}</b>
            {rscBackups?.lastRunAt ? ` · Terakhir: ${new Date(rscBackups.lastRunAt).toLocaleString('id-ID')}` : ''}
          </small>
        </div>
        <button type="button" className="noc-btn-approve" disabled={busy} onClick={() => void handleBackupNow()}>
          {busy ? 'Membackup…' : '🔄 Backup Semua .rsc Sekarang'}
        </button>
      </div>

      {feedback && <p className={`noc-feedback ${feedback.ok ? 'is-ok' : 'is-err'}`}>{feedback.text}</p>}

      {entries.length === 0 ? (
        <p style={{ fontSize: '0.82rem', color: '#64748b' }}>
          Backup otomatis pertama sedang disiapkan. Klik <b>🔄 Backup Semua .rsc Sekarang</b> untuk langsung menarik file{' '}
          <code>.rsc</code> seluruh router.
        </p>
      ) : (
        entries.map((e) => (
          <div key={e.routerId} className="noc-spv-report-item">
            <div className="noc-card-head">
              <strong>
                📄 {e.fileName} <small style={{ color: '#64748b' }}>({e.routerName})</small>
              </strong>
              <span
                className={`noc-status-pill ${e.status === 'error' ? 'is-rejected' : 'is-executed'}`}
              >
                {e.status === 'error'
                  ? 'OFFLINE / SKIP'
                  : e.addedLines > 0 || e.removedLines > 0
                    ? `+${e.addedLines} / -${e.removedLines} baris`
                    : 'Tidak Berubah'}
              </span>
            </div>
            <p style={{ margin: '4px 0', fontSize: '0.79rem', color: '#475569' }}>
              Path: <code>{e.folderPath}</code> · {e.lineCount} baris ({Math.max(1, Math.round(e.sizeBytes / 1024))} KB) ·{' '}
              {new Date(e.lastBackupAt).toLocaleString('id-ID')}
            </p>
            {e.error && (
              <small style={{ display: 'block', color: '#b91c1c', marginBottom: '4px' }}>Catatan: {e.error}</small>
            )}
            {e.diffPreview.length > 0 && (e.addedLines > 0 || e.removedLines > 0) && (
              <pre className="noc-cmd" style={{ fontSize: '0.72rem', maxHeight: '90px', overflowY: 'auto', margin: '4px 0' }}>
                {e.diffPreview.join('\n')}
              </pre>
            )}
            {e.sizeBytes > 0 && (
              <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                <a
                  href={`/api/backups/rsc/files/${encodeURIComponent(e.fileName)}?download=1`}
                  className="noc-btn-sim"
                  style={{ textDecoration: 'none', display: 'inline-block' }}
                >
                  ⬇ Download {e.fileName}
                </a>
                <button
                  type="button"
                  className="noc-btn-sim"
                  disabled={loadingFile === e.fileName}
                  onClick={() => void handleTogglePreview(e.fileName)}
                >
                  {loadingFile === e.fileName
                    ? 'Memuat…'
                    : previewFile?.fileName === e.fileName
                      ? '🔼 Tutup Isi .rsc'
                      : '👁 Lihat Isi .rsc'}
                </button>
              </div>
            )}
            {previewFile?.fileName === e.fileName && (
              <pre
                className="noc-cmd"
                style={{ marginTop: '8px', maxHeight: '240px', overflowY: 'auto', fontSize: '0.73rem' }}
              >
                {previewFile.content}
              </pre>
            )}
          </div>
        ))
      )}
    </div>
  );
}
