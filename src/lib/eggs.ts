/**
 * Easter eggs.
 *
 * Everything hidden in the app is defined here, in one pure module, so there is
 * exactly one place to look when something in the UI seems inexplicable — and
 * so the rules can be tested without a browser. Nothing here touches the draw:
 * no egg changes the pool, the RNG or the odds. They are all flavour, and a
 * user who never finds one loses nothing.
 *
 * The seven, and how each is found:
 *
 *   1. ARCANE MODE      the Konami code, typed anywhere outside a text field.
 *   2. SECRET SEARCHES  certain words typed into the hero search.
 *   3. THE INSISTENT    the same hero drawn three times running.
 *      ORACLE
 *   4. MILESTONES       crossing 50, 100, 250, 500 or 1000 lifetime draws.
 *   5. PROPHECY         tapping the stage eyebrow seven times, or typing
 *                       "oracle" — one route per input device, same egg.
 *   6. IMPATIENCE       five rolls inside three seconds.
 *   7. NOBODY LEFT      excluding every hero in the roster.
 *
 * Copy follows the app's existing voice: terse, second person, a little noir,
 * "the city" and "signal" as recurring words. No egg names a specific hero —
 * the roster changes with the game, and a joke that depends on Lash existing
 * breaks the day Lash is renamed.
 */

/* ── 1. Arcane mode ───────────────────────────────────────────────────────── */

/**
 * The Konami code, as `KeyboardEvent.code` values.
 *
 * `code` rather than `key` on purpose: `code` is the physical key, so the
 * sequence works on AZERTY and Dvorak, where `key` for the B and A positions
 * would be different letters entirely.
 */
export const KONAMI = [
  'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
  'KeyB', 'KeyA',
] as const;

/**
 * Typing `oracle` — the keyboard route to the prophecy below.
 *
 * The prophecy's other trigger is tapping the stage eyebrow, which a keyboard
 * user cannot reach. Rather than turn a decorative label into a focusable
 * button — which would put a tab stop in front of the app's primary control and
 * announce "button, THE ORACLE CHOOSES" to a screen reader without explaining
 * what it does — the same egg gets its own key sequence. Neither route is
 * discoverable, which is the point; both are operable, which is the requirement.
 */
export const INVOCATION = ['KeyO', 'KeyR', 'KeyA', 'KeyC', 'KeyL', 'KeyE'] as const;

/**
 * Fold one keypress into a progress counter for `sequence`.
 *
 * Returns how much has now been matched; `sequence.length` means it is
 * complete. A wrong key resets to 0 — except when that key is itself the start
 * of the sequence, which is why `ArrowUp ArrowUp ArrowUp ArrowDown …` still
 * works. Without that case, a hesitant third ArrowUp would silently poison the
 * attempt and the code would feel broken rather than hidden.
 */
export function advanceSequence(sequence: readonly string[], progress: number, code: string): number {
  if (code === sequence[progress]) return progress + 1;
  return code === sequence[0] ? 1 : 0;
}

export const ARCANE_ON = 'The oracle opens its other eye.';
export const ARCANE_OFF = 'The oracle returns to its usual composure.';

/* ── 2. Secret searches ───────────────────────────────────────────────────── */

/**
 * Words that answer back instead of returning "No hero matches that signal."
 *
 * Every key here is checked against the live roster by `npm test`: the search
 * box matches a hero's name *and* its aliases, and aliases carry seventeen
 * languages plus romanizations and community nicknames. A term that collides
 * with any of those would return a hero card and the egg would never fire, so
 * the collision check is a real test rather than a formality.
 */
export const SECRETS: Record<string, string> = {
  oracle: 'The oracle does not appear in its own roster.',
  deadlock: 'You are already here.',
  valve: 'Three is a difficult number for some.',
  '42': 'A fine answer. The question was about heroes.',
  xyzzy: 'Nothing happens. Something almost did.',
  konami: 'Not typed here. Somewhere with more room.',
  'the city': 'The city does not take requests.',
  gaben: 'Beyond even the oracle.',
  coin: 'A coin has two faces and no opinion. The oracle has one of each.',
  fate: 'Fate is just the draw you did not reroll.',
  destiny: 'Wrong shooter.',
  'who am i': 'Whoever the oracle says. That is the arrangement.',
};

/** The oracle's reply for a query, or null if it has nothing to say. */
export function secretFor(query: string): string | null {
  return SECRETS[query.trim().toLowerCase()] ?? null;
}

/* ── 3. The insistent oracle ──────────────────────────────────────────────── */

/** Draws of the same hero, back to back, before the oracle comments. */
export const INSISTENT_AT = 3;

/**
 * Only reachable two ways, both of which take intent: turn off *avoid recent
 * picks* and get lucky (a run of three turned up once in ~4000 rolls against a
 * 38-hero roster), or narrow the pool until one hero is left, where the
 * avoid-recent rule relaxes rather than starve the draw and the same name comes
 * back every time. Either way the user is doing something deliberate, which is
 * what makes the line land.
 */
export function insistentLine(name: string, count: number): string {
  return `The oracle has said ${name} ${count} times. It is not changing its mind.`;
}

/* ── 4. Milestones ────────────────────────────────────────────────────────── */

export const MILESTONES = [50, 100, 250, 500, 1000] as const;

/**
 * The milestone passed between two lifetime counts, if any.
 *
 * Crossing, not equality: a squad draw adds up to six at once, so counts step
 * `43 → 49 → 55` and land on 50 exactly never. Testing `pickCount === 50` would
 * make this egg unreachable for anyone who draws squads.
 */
export function milestoneCrossed(before: number, after: number): number | null {
  return MILESTONES.find((mark) => before < mark && after >= mark) ?? null;
}

export function milestoneLine(mark: number): string {
  if (mark >= 1000) return 'A thousand draws. You and the oracle are colleagues now.';
  if (mark >= 500) return 'Five hundred draws. The city has stopped asking questions.';
  if (mark >= 250) return 'Two hundred and fifty draws. This is a habit.';
  if (mark >= 100) return 'One hundred draws. The city has noticed you.';
  return 'Fifty draws. The oracle is beginning to recognise you.';
}

/* ── 5. Prophecy ──────────────────────────────────────────────────────────── */

/** Taps on the stage eyebrow, in quick succession, before the oracle speaks. */
export const EYEBROW_TAPS = 7;
/** Taps further apart than this start the count over, so idle clicks never add up. */
export const TAP_WINDOW_MS = 1200;

/**
 * Deliberately roster-independent: no line names a hero, an item or a map, so
 * nothing here rots when the game patches.
 */
export const PROPHECIES = [
  'Someone on your team will lock in before reading this. It will not go well.',
  'The lane you want is the lane someone else wants.',
  'You will blame the draw. The draw will blame you.',
  'A comeback is coming. The oracle declines to say for which side.',
  'The oracle sees a long game. The oracle is often wrong about length.',
  'Your next pick is fine. It is the one after that.',
  'Somewhere, a teammate is typing. Nothing good follows.',
  'The oracle has reviewed your draw log. The oracle has no comment.',
  'You will win the fight and lose the objective.',
  'Trust the draw. The draw does not require it.',
];

/**
 * One prophecy, chosen with the caller's generator.
 *
 * The RNG is a parameter for the same reason it is everywhere else in `lib`:
 * `Math.random()` is banned project-wide, and taking it as an argument keeps
 * this function pure and its output reproducible in a test.
 */
export function prophecy(rng: () => number): string {
  return PROPHECIES[Math.floor(rng() * PROPHECIES.length)];
}

/* ── 6. Impatience ────────────────────────────────────────────────────────── */

export const IMPATIENT_ROLLS = 5;
export const IMPATIENT_WINDOW_MS = 3000;
export const IMPATIENT_LINE = 'Patience. The oracle is not a slot machine.';

/**
 * True when the recent roll timestamps show a burst.
 *
 * `times` is expected to hold only rolls inside the window; the caller prunes.
 * This counts *deliberate* rolls — holding Space no longer produces a stream of
 * them, because the keydown handler ignores auto-repeat.
 */
export function isImpatient(times: readonly number[]): boolean {
  return times.length >= IMPATIENT_ROLLS;
}

/* ── 7. Nobody left ───────────────────────────────────────────────────────── */

/**
 * Shown when *every* hero in the roster is excluded — which is not the same as
 * an empty pool. A complexity or role filter can empty the pool too, and that
 * has its own copy telling you how to fix it. This one is for the user who has
 * gone through the whole grid on purpose.
 */
export const NOBODY_LEFT_TITLE = 'The oracle has nothing to work with';
export const NOBODY_LEFT_BODY = 'You have excluded every hero in the city. '
  + 'This is a choice, and the oracle respects it, but it cannot draw from an empty roster.';
