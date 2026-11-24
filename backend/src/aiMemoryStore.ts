import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AiLearnedFact, AiMemorySummary } from './types.js';

export interface StoredMemoryTurn {
  readonly id: string;
  readonly timestamp: string;
  readonly userSource: string;
  readonly question: string;
  readonly reply: string;
  readonly aiSource: string;
  readonly keywords: readonly string[];
}

interface PersistedAiMemory {
  readonly turns: readonly StoredMemoryTurn[];
  readonly facts: readonly AiLearnedFact[];
}

const MAX_STORED_TURNS = 500;
const MAX_LEARNED_FACTS = 120;

const STOP_WORDS = new Set([
  'yang',
  'dan',
  'atau',
  'dari',
  'untuk',
  'dengan',
  'pada',
  'di',
  'ke',
  'ini',
  'itu',
  'ada',
  'apa',
  'berapa',
  'bagaimana',
  'gimana',
  'tolong',
  'cek',
  'coba',
  'kawan',
  'boss',
  'spv',
  'noc',
  'saya',
  'kamu',
  'kita',
  'nya',
  'ya',
  'dong',
  'aja',
  'saja',
  'sekarang',
  'hari',
  'sudah',
  'belum',
  'tidak',
  'bisa',
  'kalau',
  'jika',
  'saat',
]);

export function extractKeywords(text: string): readonly string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  return Array.from(new Set(tokens)).slice(0, 24);
}

/**
 * Detects explicit teaching intents in natural Indonesian chat so Boss can teach SPV NOC directly via chat!
 * Example: "Ingat ya, sfp5 Bima menyuplai Bangomolunow dan Lolan" or "Catat: OLT Global 01 melayani area Utara"
 */
export function detectTeachingFact(question: string): string | null {
  const m = /^(?:\/ingat|ingat(?:\s+ya)?|catat(?:\s+ya)?|pelajari|simpan\s+(?:memori|fakta|info)|info\s+penting)\s*[:,-]?\s+(.{8,400})$/i.exec(
    question.trim(),
  );
  return m?.[1]?.trim() ?? null;
}

/**
 * Persistent Long-Term Memory & Knowledge Store (`data/ai-memory.json`) for SPV NOC.
 * Stores up to 500 past Q&A conversations + learned operational facts so BOTH:
 *  - Gemini Cloud AI receives relevant past context & learned SOP facts (lightweight RAG), and
 *  - Local Telemetry Engine can recall learned facts & previous diagnostics when Cloud AI is unavailable!
 */
export class AiMemoryStore {
  private readonly persistPath: string;
  private turns: readonly StoredMemoryTurn[] = [];
  private facts: readonly AiLearnedFact[] = [];
  private persistChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.persistPath = path.join(dataDir, 'ai-memory.json');
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedAiMemory>;
      this.turns = Array.isArray(parsed.turns) ? parsed.turns.slice(-MAX_STORED_TURNS) : [];
      this.facts = Array.isArray(parsed.facts) ? parsed.facts.slice(-MAX_LEARNED_FACTS) : [];
    } catch {
      this.turns = [];
      this.facts = [];
      await this.persist();
    }
  }

  getSummary(): AiMemorySummary {
    return {
      totalConversations: this.turns.length,
      learnedFacts: this.facts.slice(-60).reverse(),
    };
  }

  getRecentTurns(limit = 6): readonly StoredMemoryTurn[] {
    return this.turns.slice(-limit);
  }

  async recordConversation(
    userSource: string,
    question: string,
    reply: string,
    aiSource: string,
  ): Promise<{ readonly learnedFact: AiLearnedFact | null }> {
    const now = new Date().toISOString();
    const turn: StoredMemoryTurn = {
      id: crypto.randomUUID().slice(0, 8),
      timestamp: now,
      userSource,
      question: question.trim().slice(0, 600),
      reply: reply.trim().slice(0, 1400),
      aiSource,
      keywords: extractKeywords(`${question} ${reply.slice(0, 300)}`),
    };
    this.turns = [...this.turns, turn].slice(-MAX_STORED_TURNS);

    let learnedFact: AiLearnedFact | null = null;
    const taught = detectTeachingFact(question);
    if (taught) {
      learnedFact = await this.addFact(taught, userSource, 'Ajaran Chat');
    } else {
      await this.persist();
    }

    return { learnedFact };
  }

  async addFact(text: string, source = 'Admin NOC', topic = 'SOP & Topologi'): Promise<AiLearnedFact> {
    const clean = text.trim().slice(0, 450);
    if (!clean) {
      throw new Error('Isi pengetahuan/memori tidak boleh kosong');
    }
    // Avoid exact duplicate facts
    const existing = this.facts.find((f) => f.text.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;

    const fact: AiLearnedFact = {
      id: `mem-${crypto.randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      source,
      topic: topic.trim() || 'SOP & Topologi',
      text: clean,
    };
    this.facts = [...this.facts, fact].slice(-MAX_LEARNED_FACTS);
    await this.persist();
    return fact;
  }

  async deleteFact(factId: string): Promise<void> {
    const exists = this.facts.some((f) => f.id === factId);
    if (!exists) {
      throw new Error(`Memori ${factId} tidak ditemukan`);
    }
    this.facts = this.facts.filter((f) => f.id !== factId);
    await this.persist();
  }

  /**
   * Retrieves the most relevant learned facts + historical Q&A turns for a given question
   * using lightweight token-overlap scoring (works offline & instantaneously for both Gemini & Local AI!).
   */
  retrieveRelevantContext(question: string): {
    readonly relevantFacts: readonly AiLearnedFact[];
    readonly relevantTurns: readonly StoredMemoryTurn[];
    readonly recentTurns: readonly StoredMemoryTurn[];
  } {
    const qTokens = extractKeywords(question);
    const qSet = new Set(qTokens);

    const scoreTokens = (tokens: readonly string[]): number => {
      if (qSet.size === 0 || tokens.length === 0) return 0;
      let hits = 0;
      for (const t of tokens) {
        if (qSet.has(t)) hits += 2;
        else if (qTokens.some((q) => t.includes(q) || q.includes(t))) hits += 1;
      }
      return hits;
    };

    const scoredFacts = this.facts
      .map((f) => ({ fact: f, score: scoreTokens(extractKeywords(`${f.topic} ${f.text}`)) }))
      .sort((a, b) => b.score - a.score);

    // Always include up to 10 top facts (prioritizing matched ones + newest general SOPs)
    const matchedFacts = scoredFacts.filter((x) => x.score > 0).slice(0, 6).map((x) => x.fact);
    const matchedIds = new Set(matchedFacts.map((f) => f.id));
    const latestGeneral = [...this.facts]
      .reverse()
      .filter((f) => !matchedIds.has(f.id))
      .slice(0, 4);
    const relevantFacts = [...matchedFacts, ...latestGeneral];

    const relevantTurns = this.turns
      .map((t) => ({ turn: t, score: scoreTokens(t.keywords) }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.turn);

    const recentTurns = this.turns.slice(-4);

    return { relevantFacts, relevantTurns, recentTurns };
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify({ turns: this.turns, facts: this.facts }, null, 2);
    this.persistChain = this.persistChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
        const tmp = `${this.persistPath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
        await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(tmp, this.persistPath);
      });
    return this.persistChain;
  }
}
