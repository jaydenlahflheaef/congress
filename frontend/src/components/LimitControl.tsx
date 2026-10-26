import { useEffect, useId, useState } from 'react';

interface Props {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

/** Slider plus a typed number for the maximum distance between rests. */
export function LimitControl({ value, min, max, step, onChange }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(n / step) * step));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <fieldset className="limit">
      <legend>Maximum distance between rests</legend>
      <div className="limit-row">
        <input
          id={`${id}-range`}
          type="range"
          aria-label="Maximum distance between rests (slider)"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <label className="limit-number" htmlFor={`${id}-num`}>
          <input
            id={`${id}-num`}
            type="number"
            inputMode="numeric"
            aria-label="Maximum distance between rests in meters"
            min={min}
            max={max}
            step={step}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
            }}
          />
          <span>m</span>
        </label>
      </div>
      <p className="muted small">
        A rest at a recorded seat resets the count. This is a planning preference, not a medical estimate.
      </p>
    </fieldset>
  );
}
