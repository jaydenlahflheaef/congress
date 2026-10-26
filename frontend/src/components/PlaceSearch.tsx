import { useEffect, useId, useRef, useState } from 'react';
import { searchPlaces } from '../api/client';
import type { Mode, NamedPoint, Place } from '../types';

interface Props {
  label: string;
  mode: Mode;
  value: NamedPoint | null;
  onChange: (p: NamedPoint) => void;
  disabled?: boolean;
}

/** Search box over the imported local landmark list (no outside geocoder). */
export function PlaceSearch({ label, mode, value, onChange, disabled }: Props) {
  const id = useId();
  const [text, setText] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<Place[]>([]);
  const [active, setActive] = useState(0);
  const typed = useRef(false);

  useEffect(() => {
    setText(value?.name ?? '');
    typed.current = false;
  }, [value]);

  useEffect(() => {
    if (!open || !typed.current) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchPlaces(mode, text, ctrl.signal)
        .then((r) => {
          setHits(r.places);
          setActive(0);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, open, mode]);

  const choose = (p: Place) => {
    onChange({ name: p.name, lat: p.lat, lon: p.lon });
    setOpen(false);
  };

  return (
    <div className="place-search">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="Search local places"
        value={text}
        disabled={disabled}
        onFocus={() => {
          typed.current = true;
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          typed.current = true;
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            setActive((a) => Math.min(a + 1, hits.length - 1));
            e.preventDefault();
          } else if (e.key === 'ArrowUp') {
            setActive((a) => Math.max(a - 1, 0));
            e.preventDefault();
          } else if (e.key === 'Enter' && hits[active]) {
            choose(hits[active]);
            e.preventDefault();
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && hits.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="suggestions">
          {hits.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(p);
              }}
            >
              {p.name}
              {p.category && <span className="muted small"> · {p.category}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
