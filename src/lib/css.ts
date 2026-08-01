/**
 * Escape a feed-supplied URL for use inside a CSS `url("…")` value, so a quote
 * in the path cannot close it.
 */
export function cssUrl(url: string): string {
  return `url("${url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

export const titleCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/** Join conditional class names. */
export const classes = (...values: (string | false | undefined | null)[]): string =>
  values.filter(Boolean).join(' ');
