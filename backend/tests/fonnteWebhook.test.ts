import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FonnteWebhookProcessor,
  isWaSenderWhitelisted,
  normalizeWaIdentifier,
  parseDotPrefixedWaMessage,
  verifyWebhookSecret,
} from '../src/fonnteWebhook.js';

describe('Fonnte 2-Way WhatsApp Webhook (Dot Prefix & Sender Whitelist)', () => {
  it('normalizes Indonesian numbers & group IDs, enforces dot prefix, whitelist, anti-loop & dedup', async () => {
    // 1. Phone & Group ID normalization
    assert.equal(normalizeWaIdentifier('0812-3456-7890'), '6281234567890');
    assert.equal(normalizeWaIdentifier('+62 812 3456 7890'), '6281234567890');
    assert.equal(normalizeWaIdentifier('6281234567890@c.us'), '6281234567890');
    assert.equal(normalizeWaIdentifier('120363012345678901@g.us'), '120363012345678901@g.us');

    // 2. Dot-prefix parser
    assert.equal(parseDotPrefixedWaMessage('halo kawan'), null);
    assert.equal(parseDotPrefixedWaMessage('...'), null);
    assert.equal(parseDotPrefixedWaMessage('..'), null);
    assert.equal(parseDotPrefixedWaMessage('.menu')?.isMenuHelp, true);
    assert.equal(parseDotPrefixedWaMessage('.cek budi_01')?.prompt, '/cek budi_01');
    assert.equal(parseDotPrefixedWaMessage('.olt')?.prompt, '/olt');
    assert.equal(parseDotPrefixedWaMessage('.wifi budi')?.prompt, '/wifi budi');
    assert.equal(parseDotPrefixedWaMessage('.gimana kondisi jaringan sekarang?')?.prompt, 'gimana kondisi jaringan sekarang?');

    // 3. Whitelist matching
    assert.equal(isWaSenderWhitelisted('6281234567890', undefined, ['081234567890']), true);
    assert.equal(isWaSenderWhitelisted('6289999999999', undefined, ['081234567890']), false);
    assert.equal(
      isWaSenderWhitelisted('120363999@g.us', '6281234567890', ['081234567890']),
      true,
    );
    assert.equal(
      isWaSenderWhitelisted('120363012345678901@g.us', '6281111111111', ['120363012345678901@g.us']),
      true,
    );

    // 4. Secret verification
    assert.equal(verifyWebhookSecret('my-secret-token-123', 'my-secret-token-123'), true);
    assert.equal(verifyWebhookSecret('wrong-secret-token1', 'my-secret-token-123'), false);

    // 5. Processor flow (ignores normal chat, strangers, self-loop, duplicates; replies to whitelisted dot command)
    const processor = new FonnteWebhookProcessor();
    const replies: { target: string; message: string }[] = [];

    const run = (payload: Record<string, string>) =>
      processor.handleIncoming({
        payload,
        waChatEnabled: true,
        allowedSenders: ['081200001111'],
        onAskSpv: async (prompt) => ({ reply: `HASIL UNTUK: ${prompt}`, source: 'SPV NOC · Mock' }),
        onReplyWa: async (target, message) => {
          replies.push({ target, message });
        },
      });

    assert.equal(run({ sender: '6281200001111', message: 'halo biasa' }).reason, 'no_dot_prefix');
    assert.equal(run({ sender: '6289999999999', message: '.status' }).reason, 'sender_not_whitelisted');
    assert.equal(run({ device: '6281200001111', sender: '6281200001111', message: '.status' }).reason, 'self_loop_ignored');

    const ok1 = run({ device: '6280000000000', sender: '6281200001111', name: 'Boss', message: '.cek budi' });
    assert.equal(ok1.accepted, true);
    const dup = run({ device: '6280000000000', sender: '6281200001111', name: 'Boss', message: '.cek budi' });
    assert.equal(dup.reason, 'duplicate_ignored');

    // Wait briefly for async background reply
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.target, '6281200001111');
    assert.ok(replies[0]?.message.includes('HASIL UNTUK: /cek budi'));
  });
});
