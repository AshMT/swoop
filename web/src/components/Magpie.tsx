import { useId } from 'react';

interface MagpieProps {
  size?: number;
  className?: string;
  /** Render with die-cut sticker treatment: white cut margin + lift shadow */
  sticker?: boolean;
}

/**
 * Magpie sticker logo — wings raised wide with individual feather primaries,
 * white secondary covert bands, white belly, fan tail, and die-cut border.
 * Matches the provided black-and-white sticker illustration.
 */
export default function Magpie({ size = 40, className = '', sticker = true }: MagpieProps) {
  const uid = useId().replace(/:/g, '');
  const gId = `magpie-${uid}`;

  // 220 × 185 viewport; height derived from size prop
  const h = Math.round((size * 185) / 220);

  return (
    <svg
      width={size}
      height={h}
      viewBox="0 0 220 185"
      className={className}
      style={sticker ? { filter: 'drop-shadow(0 2px 7px rgba(0,0,0,0.35))' } : undefined}
      aria-label="Swoop magpie"
      role="img"
    >
      <defs>
        {/*
          All black shapes with NO explicit fill/stroke — attributes propagate
          from <use>: white + fat stroke for the sticker border, then black for the bird.
        */}
        <g id={gId}>

          {/* ══ RIGHT WING — sweeps upper-left ══
              Leading edge: smooth curve from body to tip.
              Trailing edge: 5 deep scallops = individual primary feather tips.
          */}
          <path d="
            M 104,98
            C 84,84 58,64 28,44
            C 17,36  4,33  3,43
            C  1,52 13,58 26,62
            C 17,68  8,74 13,81
            C 20,85 31,81 38,74
            C 32,80 25,88 31,94
            C 38,97 50,92 55,84
            C 50,91 46,98 54,102
            C 62,105 74,99  77,91
            C 82,97 90,100 99,100
            C 101,99 103,98 104,98 Z
          " />

          {/* ══ LEFT WING — sweeps upper-right ══ */}
          <path d="
            M 142,94
            C 162,82 186,64 206,46
            C 214,39 218,35 214,44
            C 210,52 198,58 186,63
            C 193,68 202,74 197,81
            C 190,85 179,81 172,74
            C 178,80 185,88 179,94
            C 172,97 160,92 155,84
            C 160,91 164,98 156,102
            C 148,105 136,99 133,91
            C 136,97 140,94 142,94 Z
          " />

          {/* ══ Body ══ */}
          <ellipse cx="122" cy="114" rx="22" ry="30" transform="rotate(-8 122 114)" />

          {/* ══ Neck ══ */}
          <ellipse cx="139" cy="91" rx="13" ry="11" transform="rotate(-26 139 91)" />

          {/* ══ Head ══ */}
          <circle cx="152" cy="74" r="18" />

          {/* ══ Beak ══ */}
          <path d="M 167,68 L 196,76 L 167,84 Z" />

          {/* ══ Tail fan — wide, spreading downward with 4 feathers ══ */}
          <path d="
            M 110,135
            C 106,146  96,159  82,170
            C  74,176  62,181  57,184
            L  66,182
            C  61,184  71,183  78,178
            L  74,181
            C  81,180  90,171  95,164
            L  92,168
            C  99,167 106,157 108,148
            L 107,153
            C 114,151 117,140 115,134
            C 115,140 116,145 122,140
            C 124,133 121,134 110,135 Z
          " />

          {/* ══ Legs — thick filled shapes ══ */}
          <path d="M 119,138 C 117,147 115,155 114,161 C 116,162 118,161 119,160 C 120,154 122,146 123,138 Z" />
          <path d="M 131,138 C 131,147 133,155 135,161 C 137,162 139,161 137,159 C 136,153 134,145 132,138 Z" />

          {/* ══ Talons ══ */}
          {/* Left foot */}
          <path d="M 114,161 C 108,164 103,163 101,159 C 103,156 108,158 112,155 Z" />
          <path d="M 114,161 C 110,167 108,171 113,172 C 115,170 115,165 117,161 Z" />
          <path d="M 114,161 C 116,167 118,171 123,170 C 124,167 121,163 118,160 Z" />
          {/* Right foot */}
          <path d="M 135,161 C 129,164 124,165 123,161 C 125,158 130,160 133,157 Z" />
          <path d="M 135,161 C 134,167 134,171 138,172 C 140,170 139,165 138,161 Z" />
          <path d="M 135,161 C 138,165 143,166 145,163 C 145,159 140,158 137,158 Z" />

        </g>
      </defs>

      {/* Die-cut sticker border */}
      {sticker && (
        <use
          href={`#${gId}`}
          fill="white"
          stroke="white"
          strokeWidth="13"
          strokeLinejoin="round"
        />
      )}

      {/* Black bird */}
      <use href={`#${gId}`} fill="#0E0E0E" />

      {/* ── White belly (large, prominent) ── */}
      <ellipse cx="120" cy="118" rx="11" ry="17" transform="rotate(-8 120 118)" fill="white" />

      {/* ── White secondary covert bands — right wing (2 stripes) ── */}
      <ellipse cx="59" cy="64" rx="18" ry="5.5" transform="rotate(-24 59 64)" fill="white" />
      <ellipse cx="43" cy="77" rx="15" ry="5" transform="rotate(-16 43 77)" fill="white" />

      {/* ── White secondary covert bands — left wing (2 stripes) ── */}
      <ellipse cx="177" cy="62" rx="18" ry="5.5" transform="rotate(24 177 62)" fill="white" />
      <ellipse cx="163" cy="75" rx="15" ry="5" transform="rotate(16 163 75)" fill="white" />

      {/* ── White tail feather accents ── */}
      <path d="M 59,181 C 64,185 72,185 76,181" stroke="white" strokeWidth="4" fill="none" strokeLinecap="round" />
      <path d="M 80,173 C 85,177 93,177 96,173" stroke="white" strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <path d="M 100,162 C 104,166 111,165 113,162" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round" />

      {/* ── Eye ── */}
      <circle cx="157" cy="71" r="5.5" fill="white" />
      <circle cx="158.5" cy="71" r="2.4" fill="#0E0E0E" />
    </svg>
  );
}
