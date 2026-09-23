import { useId } from 'react';
/**
 * Inline SVG icons.
 *
 * Kept local rather than pulling in an icon package: the set is small, and
 * every icon shipped is one the UI actually renders.
 */
interface IconProps {
  className?: string;
}

const base = 'h-4 w-4 shrink-0';

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className ?? base}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const DashboardIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="3" width="7" height="5" rx="1" />
    <rect x="14" y="12" width="7" height="9" rx="1" />
    <rect x="3" y="16" width="7" height="5" rx="1" />
  </Svg>
);

export const CalibrationIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3v18h18" />
    <path d="M7 15l4-5 3 3 4-6" />
  </Svg>
);

export const ClientsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.8 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 7 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 2.6 15H3a2 2 0 1 1 0-4h-.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);

export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </Svg>
);

export const DownloadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5M12 15V3" />
  </Svg>
);

export const ExternalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6M10 14 21 3" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);

export const SunIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
  </Svg>
);

export const MoonIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </Svg>
);

export const LogoutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </Svg>
);

export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 3 14 9-14 9V3z" />
  </Svg>
);

export const PauseIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </Svg>
);

export const QueueIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </Svg>
);

export const ApprovalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);

export const IncidentIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
  </Svg>
);

export const PeopleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const LogIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
);

export const ArrowLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </Svg>
);

/**
 * The Swoop mark: an Australian magpie in a dive, on its own wing sheen.
 * Pied black and white, white nape and shoulder band, the red-brown eye.
 */
export function SwoopLogo({ className }: IconProps) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className ?? 'h-7 w-7'} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`sheen-${id}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#14b8a6" />
          <stop offset="0.5" stopColor="#2f6fe0" />
          <stop offset="1" stopColor="#7c4ddc" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#sheen-${id})`} />
      <path d="M4 27.5c6.5 1.2 12.5-.6 17-5" stroke="#fff" strokeOpacity=".45" strokeWidth="1.4" strokeLinecap="round" />
      <g transform="translate(16 16.6) scale(1.12) translate(-15.6 -14.4)">
        <path d="M15.5 15.2C17 10.5 20.5 6.5 26.5 4.2 24.5 8 22.2 11.6 19.4 14.4Z" fill="#0c0e13" opacity=".55" />
        <path d="M19.8 15.8 28.6 12.6 27.8 14.6 20.6 17.9Z" fill="#0c0e13" />
        <path d="M8.2 21.4C9.4 18.6 13.6 15.6 18.2 15.1 20.4 14.9 21.4 16.2 20.6 17.6 18.6 20.4 13.6 23.2 10 23.4Z" fill="#0c0e13" />
        <path d="M11.4 22.6C14.4 21.9 17.8 19.9 19.9 17.8 18 20.6 14.6 22.6 11.4 22.6Z" fill="#fff" />
        <path d="M12.6 17.2C12.4 12.4 14.6 7.4 19.2 3.6 19 8.6 17.6 13 15.4 16.4Z" fill="#0c0e13" />
        <path d="M12.9 16.4C13.2 14.2 14 12.4 15.2 10.8 15.1 12.8 14.6 14.8 13.9 16.6Z" fill="#fff" />
        <circle cx="8.6" cy="21.6" r="2.7" fill="#0c0e13" />
        <path d="M9.6 19.1C11 18.9 11.8 19.8 11.6 21 11 20.4 10.4 19.9 9.6 19.1Z" fill="#fff" />
        <circle cx="7.9" cy="21.2" r=".6" fill="#c2552e" />
        <path d="M6.2 22.2 3.2 24.4 6.8 23.5Z" fill="#dfe6ec" />
        <path d="M4.1 23.7 3.2 24.4 4.3 24.1Z" fill="#0c0e13" />
      </g>
    </svg>
  );
}

/** The bare bird, for loading and empty states. Inherits colour for the body. */
export function MagpieGlyph({ className }: IconProps) {
  return (
    <svg className={className ?? 'h-6 w-6'} viewBox="2 2 28 24" fill="none" aria-hidden="true">
      <path d="M15.5 15.2C17 10.5 20.5 6.5 26.5 4.2 24.5 8 22.2 11.6 19.4 14.4Z" fill="currentColor" opacity=".45" />
      <path d="M19.8 15.8 28.6 12.6 27.8 14.6 20.6 17.9Z" fill="currentColor" />
      <path d="M8.2 21.4C9.4 18.6 13.6 15.6 18.2 15.1 20.4 14.9 21.4 16.2 20.6 17.6 18.6 20.4 13.6 23.2 10 23.4Z" fill="currentColor" />
      <path d="M11.4 22.6C14.4 21.9 17.8 19.9 19.9 17.8 18 20.6 14.6 22.6 11.4 22.6Z" fill="#fff" />
      <path d="M12.6 17.2C12.4 12.4 14.6 7.4 19.2 3.6 19 8.6 17.6 13 15.4 16.4Z" fill="currentColor" />
      <path d="M12.9 16.4C13.2 14.2 14 12.4 15.2 10.8 15.1 12.8 14.6 14.8 13.9 16.6Z" fill="#fff" />
      <circle cx="8.6" cy="21.6" r="2.7" fill="currentColor" />
      <path d="M9.6 19.1C11 18.9 11.8 19.8 11.6 21 11 20.4 10.4 19.9 9.6 19.1Z" fill="#fff" />
      <circle cx="7.9" cy="21.2" r=".6" fill="#c2552e" />
      <path d="M6.2 22.2 3.2 24.4 6.8 23.5Z" fill="#9aa6b0" />
    </svg>
  );
}
