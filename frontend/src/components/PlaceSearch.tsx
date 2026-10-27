import { useEffect, useId, useRef, useState } from "react";
import { searchPlaces } from "../api/client";
import type { Mode, NamedPoint, Place } from "../types";

interface Props {
  label: string;
  mode: Mode;
  value: NamedPoint | null;
  onChange: (p: NamedPoint | null) => void;
  disabled?: boolean;
  /** Keep the label for screen readers only (the search card shows A/B dots). */
  hideLabel?: boolean;
  placeholder?: string;
}

/** Search happens on Enter or Search, never on every keystroke. */
export function PlaceSearch({
  label,
  mode,
  value,
  onChange,
  disabled,
  hideLabel,
  placeholder,
}: Props) {
  const id = useId();
  const [text, setText] = useState(value?.name ?? "");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<Place[]>([]);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value) {
      setText(value.name);
      setOpen(false);
      request.current?.abort();
      revision.current++;
      setBusy(false);
      setMessage("");
    }
  }, [value]);
  useEffect(() => () => request.current?.abort(), []);

  const search = async () => {
    if (mode === "nearby" && text.trim().length < 3) {
      setMessage("Type a place or address in New York City.");
      return;
    }
    request.current?.abort();
    const ctrl = new AbortController();
    request.current = ctrl;
    const ticket = ++revision.current;
    setBusy(true);
    setMessage("");
    setHits([]);
    setActive(-1);
    setOpen(true);
    try {
      const r = await searchPlaces(mode, text.trim(), ctrl.signal);
      if (ticket !== revision.current) return;
      setHits(r.places);
      setMessage(
        r.places.length
          ? ""
          : "No places found in New York City. Try another name or choose a point on the map.",
      );
    } catch (e) {
      if (ticket === revision.current && (e as Error).name !== "AbortError") {
        setMessage(
          "Search is unavailable. Try again or choose a point on the map.",
        );
      }
    } finally {
      if (ticket === revision.current) setBusy(false);
    }
  };
  const choose = (p: Place) => {
    onChange({ name: p.name, lat: p.lat, lon: p.lon });
    setText(p.name);
    setOpen(false);
    setMessage("");
  };

  return (
    <div
      className="place-search"
      ref={root}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <label htmlFor={id} className={hideLabel ? "visually-hidden" : undefined}>
        {label}
      </label>
      <div className={`search-input ${value ? "has-value" : ""}`}>
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open && hits.length > 0}
          aria-controls={open && hits.length ? `${id}-list` : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            open && active >= 0 ? `${id}-option-${active}` : undefined
          }
          autoComplete="off"
          placeholder={
            placeholder ??
            (label === "From"
              ? "Starting place or address"
              : "Where are you going?")
          }
          value={text}
          disabled={disabled}
          onChange={(e) => {
            request.current?.abort();
            revision.current++;
            setText(e.target.value);
            setOpen(false);
            setHits([]);
            setMessage("");
            setBusy(false);
            if (value) onChange(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && hits.length) {
              setOpen(true);
              setActive((a) => Math.min(a + 1, hits.length - 1));
              e.preventDefault();
            } else if (e.key === "ArrowUp" && hits.length) {
              setActive((a) => Math.max(a - 1, 0));
              e.preventDefault();
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (open && active >= 0 && hits[active]) choose(hits[active]);
              else void search();
            } else if (e.key === "Escape") {
              setOpen(false);
              setActive(-1);
            }
          }}
        />
        <button
          type="button"
          className="search-submit"
          aria-label={`Search ${label === "From" ? "starting places" : "destinations"}`}
          disabled={busy || disabled}
          onClick={() => void search()}
        >
          {busy ? (
            <span className="spinner" />
          ) : (
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 5 5" />
            </svg>
          )}
        </button>
      </div>
      {busy && (
        <span className="search-feedback" role="status">
          Searching places…
        </span>
      )}
      {message && (
        <p className="search-feedback" role="status">
          {message}
        </p>
      )}
      {open && hits.length > 0 && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={`${label} search results`}
          className="suggestions"
        >
          {hits.map((p, i) => (
            <li
              key={p.id}
              id={`${id}-option-${i}`}
              role="option"
              aria-selected={i === active}
            >
              <button
                type="button"
                tabIndex={-1}
                className={i === active ? "active" : ""}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
              >
                <strong>{p.name.split(",")[0]}</strong>
                <span>
                  {p.name.split(",").slice(1).join(",").trim() ||
                    "Choose this place"}
                </span>
              </button>
            </li>
          ))}
          {mode === "nearby" && (
            <li className="search-credit" role="presentation">
              Search by Photon · © OpenStreetMap
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
