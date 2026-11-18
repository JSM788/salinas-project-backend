import { Jimp, loadFont } from 'jimp';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SANS_16_WHITE, SANS_32_WHITE } = require('jimp/fonts') as {
  SANS_16_WHITE: string;
  SANS_32_WHITE: string;
};

export interface WatermarkData {
  timestamp: string;
  coordinates?: string | null;
  customerName: string;
  district?: string | null;
  advisor?: string | null;
}

export class WatermarkService {
  private font16Promise = loadFont(SANS_16_WHITE);
  private font32Promise = loadFont(SANS_32_WHITE);

  async applyWatermark(
    base64Data: string,
    mimeType: string,
    data: WatermarkData,
  ): Promise<string> {
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const img = await Jimp.read(buffer);

      const width = img.bitmap.width;
      const height = img.bitmap.height;

      // Pick font size based on image resolution
      const isLarge = width >= 900;
      const font = await (isLarge ? this.font32Promise : this.font16Promise);

      const lineHeight = isLarge ? 36 : 20;
      const padding = isLarge ? 24 : 14;
      const bannerHeight = padding * 2 + lineHeight * 3;

      // Semi-transparent dark banner at bottom (80% black)
      const overlay = new Jimp({
        width,
        height: bannerHeight,
        color: 0x000000cc,
      });

      img.composite(overlay, 0, height - bannerHeight);

      // Clean ASCII text to ensure bitmap font renders without missing glyphs
      const clean = (str: string) =>
        str
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\x20-\x7E]/g, '');

      const line1 = clean(`FECHA: ${data.timestamp} | GPS: ${data.coordinates || 'Campo Certificado'}`);
      const line2 = clean(`CLIENTE: ${data.customerName}${data.district ? ` (${data.district})` : ''}`);
      const line3 = clean(`ASESOR: ${data.advisor || 'Comercial'} | SALINAS B2B`);

      img.print({
        font,
        x: padding,
        y: height - bannerHeight + padding,
        text: line1,
      });

      img.print({
        font,
        x: padding,
        y: height - bannerHeight + padding + lineHeight,
        text: line2,
      });

      img.print({
        font,
        x: padding,
        y: height - bannerHeight + padding + lineHeight * 2,
        text: line3,
      });

      const watermarkedBuffer = await img.getBuffer(
        mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
      );

      return watermarkedBuffer.toString('base64');
    } catch {
      // In case of any processing failure, gracefully fall back to original image
      return base64Data;
    }
  }
}

export const watermarkService = new WatermarkService();
