// KROFS huisstijl-logo als schaalbare SVG (geen bitmap): oranje kader, drie
// figuurtjes, zwarte wordmark. Kleuren via CSS-variabelen (--accent, --logo-ink)
// zodat het meebeweegt met de huisstijl.
export default function Logo({
  height = 64,
  className,
}: {
  height?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      height={height}
      viewBox="0 0 260 140"
      role="img"
      aria-label="KROFS"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="8"
        y="8"
        width="244"
        height="124"
        rx="1"
        stroke="var(--accent)"
        strokeWidth="5"
      />
      <g stroke="var(--logo-ink)" strokeWidth="3.6" strokeLinecap="round" fill="none">
        <circle cx="100" cy="44" r="8" />
        <path d="M88 66 A 12 12 0 0 1 112 66" />
        <circle cx="130" cy="37" r="9" />
        <path d="M117 66 A 13 15 0 0 1 143 66" />
        <circle cx="160" cy="44" r="8" />
        <path d="M148 66 A 12 12 0 0 1 172 66" />
      </g>
      <text
        x="130"
        y="114"
        textAnchor="middle"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        fontSize="42"
        fontWeight="800"
        letterSpacing="1.5"
        fill="var(--logo-ink)"
      >
        KROFS
      </text>
    </svg>
  );
}
