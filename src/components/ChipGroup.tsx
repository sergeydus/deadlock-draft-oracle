export interface Chip {
  value: string;
  label: string;
  ariaLabel?: string;
  active: boolean;
}

/** The segmented control used for squad size, complexity and role. */
export function ChipGroup({ label, chips, onToggle }: {
  label: string;
  chips: Chip[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="chip-group" role="group" aria-label={label}>
      {chips.map((chip) => (
        <button
          key={chip.value}
          type="button"
          className={chip.active ? 'active' : undefined}
          aria-pressed={chip.active}
          aria-label={chip.ariaLabel}
          onClick={() => onToggle(chip.value)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled row pairing explanatory copy with a control. */
export function FilterRow({ title, hint, children }: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="filter-row">
      <span><strong>{title}</strong><small>{hint}</small></span>
      {children}
    </div>
  );
}

/** The checkbox rows in the settings panel. */
export function ToggleRow({ title, hint, checked, onChange }: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-ui" />
      <span><strong>{title}</strong><small>{hint}</small></span>
    </label>
  );
}
