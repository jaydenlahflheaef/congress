/**
 * EzWay's own line icons, drawn as SVG so they look the same on every phone
 * (text arrows such as ↗ can turn into emoji on iPhones).
 */
export const ICONS = {
  locate: "M12 2v3m0 14v3M2 12h3m14 0h3M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z",
  pin: "M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10Zm0-8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  swap: "M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3",
  bench: "M6 9h12M6 13h12M4 17h16M7 17v4m10-4v4M7 9v8m10-8v8",
  arrowRight: "M5 12h14m-6-6 6 6-6 6",
  arrowLeft: "M19 12H5m6-6-6 6 6 6",
  // a walking figure heading off: used for Start and the Google Maps links
  walk: "M13 4.5a1.5 1.5 0 1 0 0-.01M9.5 21l2.5-6 2.5 2.5V21M12 15l-1-4 3-2.5 2 3 2.5 1M11 11l-3 1.5-1.5 3",
};

export function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
