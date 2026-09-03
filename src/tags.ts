/** Quality / content tags derived from the site's row attributes and <music-tag> chips. */
export type Tag = 'explicit' | 'clean' | 'ultra_hd' | 'hd' | 'dolby_atmos' | 'spatial' | 'lyrics' | 'ad_free';

export interface RawTagSource {
  /** Comma-separated attrs such as bottom-tags="LYRICS,ULTRA HD" or secondary-tags="LYRICS,HD". */
  tagAttrs?: (string | null | undefined)[];
  /** aria-labels of <music-tag> chips slotted into the row ("ULTRA HD", "LYRICS", ...). */
  chips?: (string | null | undefined)[];
  title?: string | null;
  /** Presence of the is-explicit attribute. */
  explicitAttr?: boolean;
  badge?: string | null;
}

export function parseTags(src: RawTagSource): Tag[] {
  const out = new Set<Tag>();
  const words = [...(src.tagAttrs ?? []).flatMap((a) => (a ?? '').split(',')), ...(src.chips ?? [])]
    .map((w) => (w ?? '').trim().toUpperCase())
    .filter(Boolean);
  for (const w of words) {
    if (/ULTRA\s*HD|UHD/.test(w)) out.add('ultra_hd');
    else if (/^HD$/.test(w)) out.add('hd');
    else if (/ATMOS|DOLBY/.test(w)) out.add('dolby_atmos');
    else if (/360|SPATIAL/.test(w)) out.add('spatial');
    else if (/LYRIC/.test(w)) out.add('lyrics');
    else if (/EXPLICIT/.test(w)) out.add('explicit');
    else if (/AD.?FREE/.test(w)) out.add('ad_free');
  }
  if (src.explicitAttr || /\[explicit\]/i.test(src.title ?? '')) out.add('explicit');
  if (/\[clean\]/i.test(src.title ?? '')) out.add('clean');
  if (/AD.?FREE/i.test(src.badge ?? '')) out.add('ad_free');
  return [...out];
}

/** Attribute names read from a row element for tag parsing. */
export const TAG_ATTRS = ['bottom-tags', 'secondary-tags', 'tags'] as const;
/** Chip elements slotted into rows and the mini player row. */
export const TAG_CHIP_SELECTOR = 'music-tag[aria-label]';
