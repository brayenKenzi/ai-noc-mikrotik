import dgram from 'node:dgram';
import crypto from 'node:crypto';
import type { SyslogEntry } from './types.js';

/**
 * Parses raw MikroTik remote syslog packets (RFC3164 / BSD format or plain topic,severity message).
 * Example MikroTik remote log:
 * "<30>system,error,critical login failure for user admin from 185.220.101.4 via ssh"
 */
export function parseMikrotikSyslog(
  rawLine: string,
  sourceIp: string,
  routerIdResolver: (ip: string, hostname?: string) => string,
): SyslogEntry {
  const cleaned = rawLine.trim().replace(/\0/g, '');
  let body = cleaned;
  let priSeverity: SyslogEntry['severity'] = 'info';

  const priMatch = /^<(\d{1,3})>\s*(.*)$/.exec(body);
  if (priMatch) {
    const pri = Number(priMatch[1]);
    const sevCode = pri & 0x07;
    if (sevCode <= 2) priSeverity = 'critical';
    else if (sevCode === 3) priSeverity = 'error';
    else if (sevCode === 4) priSeverity = 'warning';
    body = priMatch[2] ?? '';
  }

  // Strip optional BSD timestamp like "Nov 24 08:40:12 RouterCore "
  const bsdMatch = /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+([^\s]+)\s+(.*)$/.exec(body);
  let hostname: string | undefined;
  if (bsdMatch) {
    hostname = bsdMatch[1];
    body = bsdMatch[2] ?? body;
  }

  // Extract MikroTik topics e.g. "system,error,critical: message" or "firewall,info message"
  let topics: string[] = ['system'];
  let message = body;
  const topicMatch = /^([a-z0-9_-]+(?:,[a-z0-9_-]+)+):?\s+(.*)$/i.exec(body);
  if (topicMatch) {
    topics = (topicMatch[1] ?? 'system').toLowerCase().split(',');
    message = topicMatch[2] ?? body;
  }

  let severity: SyslogEntry['severity'] = priSeverity;
  if (topics.includes('critical')) severity = 'critical';
  else if (topics.includes('error')) severity = 'error';
  else if (topics.includes('warning')) severity = 'warning';

  const routerId = routerIdResolver(sourceIp, hostname);

  return {
    id: crypto.randomUUID(),
    routerId,
    sourceIp,
    timestamp: new Date().toISOString(),
    topics,
    severity,
    message,
  };
}

export function parseRadiusTimeoutUser(message: string): string | null {
  const match = /user\s+"?([^"\s<>]+)"?\s+authentication failed\s*-\s*radius timeout/i.exec(message);
  if (match?.[1]) return match[1];
  if (/radius\s+timeout/i.test(message) || /radius\s+server\s+(?:not responding|timeout|unreachable)/i.test(message)) {
    const fallbackUser = /user\s+"?([^"\s<>]+)"?/i.exec(message);
    return fallbackUser?.[1] ?? 'unknown';
  }
  return null;
}

export function isRadiusTimeoutMessage(message: string): boolean {
  return parseRadiusTimeoutUser(message) !== null;
}

export function isAnomalySyslog(entry: SyslogEntry): boolean {
  const msg = entry.message.toLowerCase();
  if (isRadiusTimeoutMessage(entry.message)) {
    return true;
  }
  if (entry.severity === 'critical' || entry.severity === 'error') {
    return true;
  }
  return (
    msg.includes('radius timeout') ||
    msg.includes('authentication failed') ||
    msg.includes('login failure') ||
    msg.includes('link down') ||
    msg.includes('bgp') ||
    msg.includes('ospf') ||
    msg.includes('loop') ||
    msg.includes('ddos') ||
    msg.includes('port scan')
  );
}

export class SyslogUdpServer {
  private socket: dgram.Socket | null = null;
  private readonly port: number;
  private readonly routerIdResolver: (ip: string, hostname?: string) => string;
  private readonly onLog: (entry: SyslogEntry) => void;

  constructor(
    port: number,
    routerIdResolver: (ip: string, hostname?: string) => string,
    onLog: (entry: SyslogEntry) => void,
  ) {
    this.port = port;
    this.routerIdResolver = routerIdResolver;
    this.onLog = onLog;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      this.socket = sock;

      sock.once('error', (err) => {
        reject(err);
      });

      sock.on('message', (msg, rinfo) => {
        const lines = msg.toString('utf8').split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          const parsed = parseMikrotikSyslog(line, rinfo.address, this.routerIdResolver);
          this.onLog(parsed);
        }
      });

      sock.bind(this.port, '0.0.0.0', () => {
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket) {
        resolve();
        return;
      }
      this.socket.close(() => {
        this.socket = null;
        resolve();
      });
    });
  }
}
