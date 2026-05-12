import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';

export interface QrArtifactPaths {
  rawPath: string;
  terminalPath: string;
  pngPath: string;
}

export async function writeQrArtifacts(qrPayload: string, outputDir = './data'): Promise<QrArtifactPaths> {
  await mkdir(outputDir, { recursive: true });

  const rawPath = join(outputDir, 'latest-qr.txt');
  const terminalPath = join(outputDir, 'latest-qr-terminal.txt');
  const pngPath = join(outputDir, 'latest-qr.png');
  const terminalQr = await toTerminalQr(qrPayload);

  await Promise.all([
    writeFile(rawPath, qrPayload),
    writeFile(terminalPath, terminalQr),
    QRCode.toFile(pngPath, qrPayload, {
      errorCorrectionLevel: 'M',
      margin: 3,
      scale: 10,
      type: 'png'
    })
  ]);

  return { rawPath, terminalPath, pngPath };
}

function toTerminalQr(qrPayload: string): Promise<string> {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(qrPayload, { small: true }, resolve);
  });
}
