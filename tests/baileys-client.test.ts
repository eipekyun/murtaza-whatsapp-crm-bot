import { describe, expect, it } from 'vitest';
import { extForMime, mediaExceedsLimit, parseMessageEdit, safeSegment, toInboundMessage } from '../src/whatsapp/baileys-client.js';
import type { RuntimeConfig } from '../src/config.js';

const config: RuntimeConfig = {
  tenantId: 'esmark-test',
  displayName: 'ESMARK Asistan',
  dbPath: './data/poc.sqlite',
  authDir: './data/auth/esmark-test',
  whitelistPhones: ['905322013401'],
  autoReply: true,
  autoReplyAudience: 'whitelist',
  operatorPort: 8787,
  operatorToken: '0123456789abcdef0123456789abcdef',
  operatorHost: '127.0.0.1',
  operatorNoAuth: false,
  archiveMedia: true,
  archiveKinds: ['image', 'video', 'document', 'audio'],
  maxMediaBytes: 50 * 1024 * 1024,
  mediaIncomingDir: './data/media/incoming',
  drivePython: '/usr/bin/python3',
  driveUploadScript: './scripts/wa_drive_upload.py',
  driveTokenPath: '/tmp/drive_token.json',
  customersDir: './01-Musteriler',
  groupMapPath: './02-Temel/WhatsApp-Grup-Eslemesi.md',
  perfexQueryPython: '/usr/bin/python3',
  perfexQueryScript: './scripts/perfex-query.py',
  perfexOpsEnvPath: '/home/murtaza/.config/murtaza-vps-ops.env'
};

describe('baileys inbound message mapping', () => {
  it('uses remoteJid as sender phone when participant is an empty string', () => {
    const inbound = toInboundMessage(config, {
      key: {
        fromMe: false,
        id: 'msg-1',
        remoteJid: '905322013401@s.whatsapp.net',
        participant: ''
      },
      pushName: 'Ersin',
      message: { conversation: 'Merhaba' },
      messageTimestamp: 1778603315
    } as any);

    expect(inbound?.chatId).toBe('905322013401@s.whatsapp.net');
    expect(inbound?.senderPhone).toBe('905322013401');
    expect(inbound?.text).toBe('Merhaba');
  });
});

describe('parseMessageEdit (WhatsApp mesaj düzenleme)', () => {
  it('conversation edit → orijinal messageId + yeni metin + editedAt (timestamp)', () => {
    const edit = parseMessageEdit({
      key: { id: 'orig-1' },
      update: {
        message: { editedMessage: { message: { conversation: 'düzeltilmiş metin' } } },
        messageTimestamp: 1778603400
      }
    });
    expect(edit).not.toBeNull();
    expect(edit?.messageId).toBe('orig-1');
    expect(edit?.newText).toBe('düzeltilmiş metin');
    expect(edit?.editedAt.getTime()).toBe(1778603400 * 1000);
  });

  it('extendedTextMessage düzenleme metnini çıkarır', () => {
    const edit = parseMessageEdit({
      key: { id: 'orig-2' },
      update: { message: { editedMessage: { message: { extendedTextMessage: { text: 'uzun düzeltme' } } } } }
    });
    expect(edit?.newText).toBe('uzun düzeltme');
  });

  it('düzenleme olmayan (yalnız status) update → null', () => {
    expect(parseMessageEdit({ key: { id: 'm1' }, update: { } })).toBeNull();
  });

  it('key.id yoksa → null', () => {
    expect(
      parseMessageEdit({ key: {}, update: { message: { editedMessage: { message: { conversation: 'x' } } } } })
    ).toBeNull();
  });

  it('düzenleme içeriği boş metinse → null', () => {
    expect(
      parseMessageEdit({ key: { id: 'm2' }, update: { message: { editedMessage: { message: { conversation: '' } } } } })
    ).toBeNull();
  });
});

describe('media local-file helpers', () => {
  it('safeSegment strips path-unsafe chars from jid/messageId', () => {
    expect(safeSegment('905322013401@s.whatsapp.net')).toBe('905322013401_s.whatsapp.net');
    expect(safeSegment('29132796747799@lid')).toBe('29132796747799_lid');
    expect(safeSegment('')).toBe('x');
  });

  it('extForMime maps known mimes and falls back to kind default', () => {
    expect(extForMime('image/png', 'image')).toBe('.png');
    expect(extForMime('video/mp4', 'video')).toBe('.mp4');
    expect(extForMime('application/pdf', 'document')).toBe('.pdf');
    expect(extForMime(undefined, 'audio')).toBe('.ogg');
    expect(extForMime('application/unknown', 'document')).toBe('.bin');
  });

  it('mediaExceedsLimit handles number, string, Long-like and missing fileLength', () => {
    // limit yoksa veya 0 ise asla aşmaz (limitsiz)
    expect(mediaExceedsLimit(60_000_000, undefined)).toBe(false);
    expect(mediaExceedsLimit(60_000_000, 0)).toBe(false);
    // limit içi / dışı (number)
    expect(mediaExceedsLimit(10_000, 50_000_000)).toBe(false);
    expect(mediaExceedsLimit(60_000_000, 50_000_000)).toBe(true);
    // fileLength bilinmiyorsa indir (false)
    expect(mediaExceedsLimit(undefined, 50_000_000)).toBe(false);
    expect(mediaExceedsLimit(null, 50_000_000)).toBe(false);
    // Baileys Long objesi (toNumber) ve string
    expect(mediaExceedsLimit({ toNumber: () => 60_000_000 }, 50_000_000)).toBe(true);
    expect(mediaExceedsLimit('60000000', 50_000_000)).toBe(true);
    expect(mediaExceedsLimit('abc', 50_000_000)).toBe(false);
  });
});
