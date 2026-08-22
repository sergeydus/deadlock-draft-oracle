/**
 * Feed parsing.
 *
 * The two sources return quite different shapes and both change without notice,
 * so every accessor here tolerates a missing or renamed field rather than throw.
 * Do not "simplify" these to direct property access.
 */
import type { Hero } from '../types.ts';

/** Feed entries are untyped JSON; this is the honest type for them. */
type Raw = Record<string, any>;

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }

export function firstText(...values: unknown[]): string {
  return values.find((value) => text(value).trim()) as string | undefined || '';
}

export function localized(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const object = value as Raw;
    return firstText(object.english, object.en, object.value, object.text);
  }
  return '';
}

export function imageFrom(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const object = value as Raw;
    return firstText(
      object.url, object.large, object.full, object.hero, object.image, object.publicPath, object.card, object.portrait,
      // deadlock-api v2 nests art under `images` with these names.
      object.icon_hero_card, object.hero_card_critical, object.top_bar_vertical_image, object.minimap_image,
    );
  }
  return '';
}

/** Descriptions arrive as a plain string, a localized object, or {lore, role, playstyle}. */
export function descriptionFrom(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const object = value as Raw;
  return firstText(localized(object), object.role, object.playstyle, object.lore);
}

/**
 * Flatten every localized spelling of a hero's name into one searchable string.
 * deadlock.io ships 17 languages plus romanizations and community nicknames in
 * `searchName` ("infa-nasu", "火男"), which makes the search box work for players
 * who do not type the English name.
 */
export function aliasesFrom(raw: Raw): string {
  const parts = new Set<string>();
  for (const field of [raw.searchName, raw.displayName, raw.name, raw.localized_name]) {
    if (typeof field === 'string') parts.add(field);
    else if (field && typeof field === 'object') {
      const values = field.byLanguage && typeof field.byLanguage === 'object' ? field.byLanguage : field;
      for (const value of Object.values(values)) if (typeof value === 'string') parts.add(value);
    }
  }
  return [...parts].join(' ').toLowerCase();
}

export function absoluteImage(path: string, origin: string): string {
  if (!path) return path;
  if (path.startsWith('//')) return `https:${path}`;
  try { return new URL(path, origin).href; } catch { return path; }
}

/** Feeds return either a bare array, a wrapper object, or an id-keyed map. */
export function unwrap(raw: unknown): Raw[] {
  if (Array.isArray(raw)) return raw;
  const object = (raw ?? {}) as Raw;
  for (const key of ['heroes', 'data', 'results', 'items']) if (Array.isArray(object[key])) return object[key];
  return Object.values(object).filter((value): value is Raw => Boolean(value) && typeof value === 'object');
}

/** Null for entries that are not real heroes (dev placeholders, dota leftovers). */
export function normalise(raw: Raw, index: number, origin: string): Hero | null {
  const name = firstText(raw.name, raw.display_name, localized(raw.displayName), raw.localized_name, raw.hero_name, raw.internal_name, raw.id);
  if (!name || /^(hero_|npc_dota_hero)/i.test(name)) return null;

  // Newer heroes ship lore but no playstyle blurb, so lore is the last resort
  // rather than nothing — it is long, which is why .hero-description clamps.
  const description = firstText(descriptionFrom(raw.description), raw.summary, raw.short_description, raw.tagline, raw.role, localized(raw.playstyle), localized(raw.lore));
  const image = absoluteImage(
    imageFrom(raw.image) || imageFrom(raw.images) || imageFrom(raw.thumbnail) || imageFrom(raw.portrait) || imageFrom(raw.icon) || imageFrom(raw.assets?.card) || imageFrom(raw.assets?.portrait) || imageFrom(raw.assets?.image),
    origin,
  );

  // Both feeds expose the engine class name ("hero_inferno" / "inferno"), so
  // stripping and lowercasing it yields the SAME id from either source. Ids are
  // the key for exclusions, the tally and share links, so keeping them stable
  // across a failover matters — do not swap this back to the numeric feed id.
  const idSource = firstText(raw.class_name, raw.codeName, raw.internal_name, String(raw.id ?? ''), String(raw.hero_id ?? ''), name);
  const id = idSource.replace(/^hero_/i, '').toLowerCase() || String(index);

  const rawStatus = String(raw.status ?? raw.release_status ?? raw.type ?? '').toLowerCase();
  const released = !(raw.is_unreleased || raw.unreleased || raw.disabled || raw.playable === false
    || raw.playerSelectable === false || raw.player_selectable === false || raw.inDevelopment || raw.in_development
    || raw.needs_testing || raw.prerelease_only || raw.limited_testing || raw.assigned_players_only
    || /unreleased|upcoming|test/.test(rawStatus));

  // These are split across the feeds — deadlock-api has role/accent, deadlock.io
  // has the localized aliases — so the enrichment pass merges them.
  const complexity = Number.isFinite(Number(raw.complexity)) ? Number(raw.complexity) : 0;
  const role = firstText(raw.hero_type, raw.heroType, raw.role_name).toLowerCase();
  const weapon = firstText(localized(raw.gunArchetype), raw.gun_tag, raw.weapon_archetype);
  const accent = firstText(raw.colors?.style_hex, raw.colors?.ui_hex, raw.color);

  return {
    id,
    name: name.replace(/^hero_/i, '').replace(/_/g, ' '),
    description,
    image,
    released,
    complexity: complexity > 0 ? complexity : 0,
    role,
    weapon,
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : '',
    aliases: aliasesFrom(raw),
  };
}

/** Fields the enrichment pass may copy from another feed when the base one lacked them. */
export const MERGEABLE_FIELDS = ['role', 'weapon', 'accent', 'aliases', 'description', 'image'] as const;
