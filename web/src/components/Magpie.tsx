import { useId } from 'react';

interface MagpieProps {
  size?: number;
  className?: string;
  /** Render with die-cut sticker treatment: white cut margin + lift shadow */
  sticker?: boolean;
}

/**
 * Stylized magpie in flight — wings swept up, head right, tail fanned down-left.
 * The ink silhouette lives in <defs>; the sticker effect duplicates it
 * underneath with a fat white stroke so the white margin follows the
 * bird's outline exactly, like a die-cut sticker.
 */
export default function Magpie({ size = 40, className = '', sticker = true }: MagpieProps) {
  const id = useId().replace(/:/g, '');
  const inkId = `magpie-ink-${id}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      className={className}
      style={sticker ? { filter: 'drop-shadow(0 3px 5px rgba(14,14,14,0.28))' } : undefined}
      aria-label="Swoop magpie"
      role="img"
    >
      <defs>
        <g id={inkId}>
          {/* Right wing — steep fan so the head and beak stay clear below it */}
          <ellipse cx="92" cy="31" rx="23" ry="5.5" transform="rotate(-35 92 31)" />
          <ellipse cx="87" cy="27.5" rx="22" ry="5" transform="rotate(-52 87 27.5)" />
          <ellipse cx="81" cy="26" rx="19" ry="4.8" transform="rotate(-68 81 26)" />
          <ellipse cx="76" cy="28" rx="16" ry="4.5" transform="rotate(-82 76 28)" />
          {/* Left wing */}
          <ellipse cx="44" cy="33" rx="23" ry="5.5" transform="rotate(35 44 33)" />
          <ellipse cx="49" cy="29.5" rx="22" ry="5" transform="rotate(52 49 29.5)" />
          <ellipse cx="55" cy="28" rx="19" ry="4.8" transform="rotate(68 55 28)" />
          <ellipse cx="60" cy="30" rx="16" ry="4.5" transform="rotate(82 60 30)" />
          {/* Tail — long fan down-left */}
          <ellipse cx="41.5" cy="83.5" rx="19" ry="4.5" transform="rotate(-30 41.5 83.5)" />
          <ellipse cx="45.3" cy="86.7" rx="19" ry="4.5" transform="rotate(-45 45.3 86.7)" />
          <ellipse cx="50" cy="88" rx="18" ry="4.5" transform="rotate(-60 50 88)" />
          {/* Body — diagonal, hip lower-left to neck upper-right */}
          <ellipse cx="76" cy="42" rx="9" ry="7" transform="rotate(-30 76 42)" />
      <ellipse cx="58" cy="43" rx="9" ry="7" transform="rotate(30 58 43)" />
      <ellipse cx="68" cy="60" rx="13" ry="19" transform="rotate(-28 68 60)" />
          {/* Head */}
          <circle cx="86" cy="38" r="10.5" />
          {/* Beak */}
          <path d="M95 34 L110 40 L95 46 Z" />
        </g>
      </defs>

      {sticker && (
        /* Die-cut white margin: fattened all-white copy of the silhouette */
        <use href={`#${inkId}`} fill="#ffffff" stroke="#ffffff" strokeWidth="9" strokeLinejoin="round" />
      )}

      {/* Ink bird */}
      <use href={`#${inkId}`} fill="#0E0E0E" />

      {/* White markings — wing bands, belly, tail band */}
      <ellipse cx="89" cy="29" rx="7" ry="2.6" transform="rotate(-35 89 29)" fill="#ffffff" />
      <ellipse cx="84" cy="23" rx="6" ry="2.3" transform="rotate(-52 84 23)" fill="#ffffff" />
      <ellipse cx="47" cy="31" rx="7" ry="2.6" transform="rotate(35 47 31)" fill="#ffffff" />
      <ellipse cx="52" cy="25" rx="6" ry="2.3" transform="rotate(52 52 25)" fill="#ffffff" />
      <ellipse cx="66" cy="62" rx="4.5" ry="7.5" transform="rotate(-28 66 62)" fill="#ffffff" />
      <ellipse cx="36" cy="88" rx="6" ry="2.4" transform="rotate(-30 36 88)" fill="#ffffff" />
      {/* Eye */}
      <circle cx="89.5" cy="35.5" r="2.5" fill="#ffffff" />
      <circle cx="90.2" cy="35.5" r="1.1" fill="#0E0E0E" />
    </svg>
  );
}
