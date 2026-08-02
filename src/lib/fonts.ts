import type { CaptionEntrance, CaptionStyle } from '../types';

export interface FontOption {
  id: string;
  label: string;
  family: string;
  /** Caption weight that reads well for this face. */
  weight: number;
  /** Weight used for **bold** markup. */
  bold: number;
}

export const FONTS: FontOption[] = [
  { id: 'system', label: 'Sans (default)', family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif", weight: 650, bold: 800 },
  { id: 'cormorant', label: 'Cormorant', family: "'Cormorant Garamond', Georgia, serif", weight: 600, bold: 700 },
  { id: 'playfair', label: 'Playfair Display', family: "'Playfair Display', Georgia, serif", weight: 600, bold: 800 },
  { id: 'montserrat', label: 'Montserrat', family: "'Montserrat', sans-serif", weight: 600, bold: 800 },
  { id: 'bebas', label: 'Bebas Neue', family: "'Bebas Neue', Impact, sans-serif", weight: 400, bold: 400 },
];

export const DEFAULT_FONT = 'cormorant';
export const DEFAULT_HIGHLIGHT = '#f2c14e';
/** 1 = original image brightness, 0 = black. 0.45 gives readable contrast without flattening the image. */
export const DEFAULT_BG_BRIGHTNESS = 0.45;
/** Subtitle size multiplier; 1 = default auto-fit size. */
export const DEFAULT_CAPTION_SCALE = 0.8;
export const DEFAULT_CAPTION_STYLE: CaptionStyle = 'word';
export const DEFAULT_CAPTION_ENTRANCE: CaptionEntrance = 'none';

export function font(id: string): FontOption {
  return FONTS.find((f) => f.id === id) ?? FONTS[0];
}

/**
 * Wait for a caption face's weights to be usable for measurement. Text measured before the webfont
 * loads is measured in the fallback face, so anything that decides layout from it (export framing,
 * crowding detection) has to await this first.
 */
export async function loadCaptionFont(f: FontOption): Promise<void> {
  const primary = f.family.split(',')[0].trim();
  await Promise.allSettled([
    document.fonts.load(`${f.weight} 64px ${primary}`),
    document.fonts.load(`${f.bold} 64px ${primary}`),
    document.fonts.load(`italic ${f.weight} 64px ${primary}`),
  ]);
}
